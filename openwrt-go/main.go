package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	WorkerBaseURL  string `json:"worker_base_url"`
	SharedSecret   string `json:"shared_secret_router"`
	NftTable       string `json:"nft_table"`
	NftSetV4Name   string `json:"nft_set_v4_name"`
	NftSetV6Name   string `json:"nft_set_v6_name"`
	LongPollSec    int    `json:"long_poll_timeout_sec"`
	RetryWaitSec   int    `json:"retry_wait_sec"`
	SyncTimeoutSec int    `json:"sync_timeout_sec"`
	LockFile       string `json:"lock_file"`
}

type workerResp struct {
	IPs        []string `json:"ips"`
	LastUpdate int64    `json:"last_updated"`
	Status     string   `json:"status"`
}

func defaultConfig() Config {
	return Config{
		NftTable:       "inet fw4",
		NftSetV4Name:   "knock_ipv4",
		NftSetV6Name:   "knock_ipv6",
		LongPollSec:    65,
		RetryWaitSec:   5,
		SyncTimeoutSec: 15,
		LockFile:       "/var/run/knock-sync.lock",
	}
}

func trimQuotes(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

// loadDotEnv reads KEY=VALUE lines into the process environment.
// Variables that are already set are left unchanged.
// Search order: $KNOCK_ENV_FILE, otherwise /etc/knock.env then ./.env.
func loadDotEnv() {
	candidates := []string{"/etc/knock.env", ".env"}
	if explicit := strings.TrimSpace(os.Getenv("KNOCK_ENV_FILE")); explicit != "" {
		candidates = []string{explicit}
	}
	var file *os.File
	for _, path := range candidates {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		file = f
		break
	}
	if file == nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" || strings.ContainsAny(key, " \t") {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, trimQuotes(strings.TrimSpace(value)))
	}
}

func applyEnvOverrides(cfg *Config) {
	if value := strings.TrimSpace(os.Getenv("WORKER_BASE_URL")); value != "" {
		cfg.WorkerBaseURL = value
	}
	if value := strings.TrimSpace(os.Getenv("SHARED_SECRET_ROUTER")); value != "" {
		cfg.SharedSecret = value
	}
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	loadDotEnv()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return cfg, err
		}
		if err == nil && len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &cfg); err != nil {
				return cfg, err
			}
		}
	}
	// Environment wins over the JSON file so secrets stay out of config files
	// that might be copied around.
	applyEnvOverrides(&cfg)
	if strings.TrimSpace(cfg.WorkerBaseURL) == "" || strings.TrimSpace(cfg.SharedSecret) == "" {
		return cfg, errors.New("worker_base_url and shared_secret_router must be set via environment or config")
	}
	return cfg, nil
}

func acquireLock(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, err
	}
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteString(strconv.Itoa(os.Getpid()))
	}
	return f, nil
}

func nftFlushSet(table, setName string) error {
	parts := strings.Fields(table)
	args := append([]string{"flush", "set"}, parts...)
	args = append(args, setName)
	return exec.Command("nft", args...).Run()
}

func nftAddElement(table, setName, ip string) error {
	parts := strings.Fields(table)
	args := append([]string{"add", "element"}, parts...)
	args = append(args, setName, "{", ip, "}")
	return exec.Command("nft", args...).Run()
}

func flushAndLoad(table, v4Name, v6Name string, ips []string) error {
	if err := nftFlushSet(table, v4Name); err != nil {
		return err
	}
	if err := nftFlushSet(table, v6Name); err != nil {
		return err
	}
	for _, ip := range ips {
		parsed := net.ParseIP(strings.TrimSpace(ip))
		if parsed == nil {
			continue
		}
		if parsed.To4() != nil {
			_ = nftAddElement(table, v4Name, ip)
		} else {
			_ = nftAddElement(table, v6Name, ip)
		}
	}
	return nil
}

func callWorker(client *http.Client, url string, secret string) (workerResp, error) {
	var out workerResp
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("X-Router-Secret", secret)
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("worker status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, err
	}
	return out, nil
}

func callWorkerWithTimeout(baseClient *http.Client, timeout time.Duration, url string, secret string) (workerResp, error) {
	client := *baseClient
	client.Timeout = timeout
	return callWorker(&client, url, secret)
}

func run(cfg Config) error {
	lock, err := acquireLock(cfg.LockFile)
	if err != nil {
		log.Printf("another instance running, exit: %v", err)
		return nil
	}
	defer func() {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
	}()

	// Ensure nft command can operate on target sets.
	// Sets should be defined by fw4 (firewall config).
	if err := nftFlushSet(cfg.NftTable, cfg.NftSetV4Name); err != nil {
		return fmt.Errorf("nft set v4 not ready (%s %s): %w", cfg.NftTable, cfg.NftSetV4Name, err)
	}
	if err := nftFlushSet(cfg.NftTable, cfg.NftSetV6Name); err != nil {
		return fmt.Errorf("nft set v6 not ready (%s %s): %w", cfg.NftTable, cfg.NftSetV6Name, err)
	}

	client := &http.Client{}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	lastUpdated := int64(0)
	syncURL := strings.TrimRight(cfg.WorkerBaseURL, "/") + "/get_current_ips"
	pollBase := strings.TrimRight(cfg.WorkerBaseURL, "/") + "/long_poll_for_ip_updates?since="

	first, err := callWorkerWithTimeout(
		client,
		time.Duration(cfg.SyncTimeoutSec)*time.Second,
		syncURL,
		cfg.SharedSecret,
	)
	if err != nil {
		log.Printf("initial sync failed: %v", err)
	} else {
		_ = flushAndLoad(cfg.NftTable, cfg.NftSetV4Name, cfg.NftSetV6Name, first.IPs)
		lastUpdated = first.LastUpdate
		log.Printf("initial sync ok, ips=%d, last=%d", len(first.IPs), lastUpdated)
	}

	for {
		select {
		case <-ctx.Done():
			log.Printf("stopped by signal")
			return nil
		default:
		}

		pollURL := pollBase + strconv.FormatInt(lastUpdated, 10)
		pollTimeout := time.Duration(cfg.LongPollSec+10) * time.Second
		resp, err := callWorkerWithTimeout(client, pollTimeout, pollURL, cfg.SharedSecret)
		if err != nil {
			log.Printf("poll error: %v", err)
			time.Sleep(time.Duration(cfg.RetryWaitSec) * time.Second)
			continue
		}
		if resp.LastUpdate > 0 {
			lastUpdated = resp.LastUpdate
		}
		switch resp.Status {
		case "updated", "cleaned", "current":
			if err := flushAndLoad(cfg.NftTable, cfg.NftSetV4Name, cfg.NftSetV6Name, resp.IPs); err != nil {
				log.Printf("nft set update failed: %v", err)
			} else {
				log.Printf("applied status=%s ips=%d last=%d", resp.Status, len(resp.IPs), lastUpdated)
			}
		case "timeout":
			log.Printf("poll timeout, no change")
		default:
			log.Printf("unknown status=%s", resp.Status)
		}
	}
}

func main() {
	configPath := flag.String("config", "/etc/knock-sync.json", "config file path")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config failed: %v", err)
	}
	if err := run(cfg); err != nil {
		log.Fatalf("run failed: %v", err)
	}
}
