#!/bin/ash

# OpenWrt ipset sync script for Cloudflare Worker HTTP knock.
# Modes:
#   init - create ipsets and initial sync once
#   run  - long-poll Worker and continuously update ipset

set -u

# Configuration is injected from the environment or an env file.
# Already-exported variables win over the file.
# Env file search order:
#   1. $KNOCK_ENV_FILE (only this file, when the variable is set)
#   2. /etc/knock.env
#   3. ./.env
#
# Required keys: WORKER_BASE_URL, SHARED_SECRET_ROUTER
# See .env.example in the repo. Do not hardcode secrets or hosts here.

load_env_file() {
  local file="$1"
  local line key value
  [ -n "${file}" ] && [ -f "${file}" ] || return 0
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$(printf '\r')}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "${line}" in
      ""|\#*) continue ;;
    esac
    case "${line}" in
      export\ *) line="${line#export }" ;;
    esac
    case "${line}" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "${key}" in
      ""|*[!A-Za-z0-9_]*) continue ;;
    esac
    case "${value}" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Do not override variables that are already set.
    if eval "[ -n \"\${${key}+x}\" ]"; then
      continue
    fi
    export "${key}=${value}"
  done < "${file}"
}

if [ -n "${KNOCK_ENV_FILE-}" ]; then
  load_env_file "${KNOCK_ENV_FILE}"
elif [ -f /etc/knock.env ]; then
  load_env_file /etc/knock.env
elif [ -f ./.env ]; then
  load_env_file ./.env
fi

: "${WORKER_BASE_URL:=}"
: "${SHARED_SECRET_ROUTER:=}"
WORKER_BASE_URL="${WORKER_BASE_URL%/}"
: "${IPSET_V4_NAME:=knock_ipv4}"
: "${IPSET_V6_NAME:=knock_ipv6}"
: "${LOG_FILE:=/var/log/http_knock_openwrt.log}"
: "${LONG_POLL_TIMEOUT_SEC:=65}"
: "${RETRY_WAIT_SEC:=5}"
: "${LOCK_DIR:=/var/run/openwrt-http-knock.lock}"
LOCK_PID_FILE="${LOCK_DIR}/pid"

SYNC_URL="${WORKER_BASE_URL}/get_current_ips"
LONG_POLL_URL="${WORKER_BASE_URL}/long_poll_for_ip_updates"

LAST_UPDATED=0

log_message() {
  local msg="$1"
  echo "$(date "+%Y-%m-%d %H:%M:%S %Z") [http-knock] ${msg}" | tee -a "${LOG_FILE}"
}

acquire_run_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$" > "${LOCK_PID_FILE}"
    trap 'release_run_lock' EXIT INT TERM
    return 0
  fi

  if [ -f "${LOCK_PID_FILE}" ]; then
    local old_pid
    old_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null)"
    if [ -n "${old_pid}" ] && kill -0 "${old_pid}" 2>/dev/null; then
      log_message "Another run instance is already active (pid=${old_pid}), exiting."
      return 1
    fi
  fi

  log_message "Found stale lock, cleaning and retrying."
  rm -rf "${LOCK_DIR}" 2>/dev/null
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$" > "${LOCK_PID_FILE}"
    trap 'release_run_lock' EXIT INT TERM
    return 0
  fi

  log_message "Failed to acquire lock directory ${LOCK_DIR}."
  return 1
}

release_run_lock() {
  if [ -f "${LOCK_PID_FILE}" ]; then
    local current_pid
    current_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null)"
    if [ "${current_pid}" = "$$" ]; then
      rm -rf "${LOCK_DIR}" 2>/dev/null
    fi
  fi
}

check_config() {
  if [ -z "${WORKER_BASE_URL}" ]; then
    log_message "Error: WORKER_BASE_URL is not set. Export it or put it in /etc/knock.env."
    return 1
  fi
  if [ -z "${SHARED_SECRET_ROUTER}" ]; then
    log_message "Error: SHARED_SECRET_ROUTER is not set. Export it or put it in /etc/knock.env."
    return 1
  fi
  return 0
}

require_commands() {
  local missing=0
  for cmd in curl ipset jsonfilter grep; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      log_message "Error: missing command: ${cmd}"
      missing=1
    fi
  done

  if [ "${missing}" -ne 0 ]; then
    return 1
  fi
  return 0
}

ensure_ipsets() {
  if ! ipset list "${IPSET_V4_NAME}" >/dev/null 2>&1; then
    log_message "Creating ipset ${IPSET_V4_NAME}"
    ipset create "${IPSET_V4_NAME}" hash:ip maxelem 4096 || return 1
  fi

  if ! ipset list "${IPSET_V6_NAME}" >/dev/null 2>&1; then
    log_message "Creating ipset ${IPSET_V6_NAME}"
    ipset create "${IPSET_V6_NAME}" hash:net family inet6 maxelem 4096 || return 1
  fi

  return 0
}

flush_and_load_ips() {
  local response="$1"
  local all_ips
  local ip

  all_ips="$(echo "${response}" | jsonfilter -e '@.ips[*]' -q 2>/dev/null)"
  if [ -z "${all_ips}" ]; then
    log_message "Warning: no IPs in response; flushing ipsets."
    ipset flush "${IPSET_V4_NAME}"
    ipset flush "${IPSET_V6_NAME}"
    return 0
  fi

  ipset flush "${IPSET_V4_NAME}"
  ipset flush "${IPSET_V6_NAME}"

  for ip in ${all_ips}; do
    if echo "${ip}" | grep -q ":"; then
      ipset add "${IPSET_V6_NAME}" "${ip}" >/dev/null 2>&1 || log_message "Warning: failed add IPv6 ${ip}"
    else
      ipset add "${IPSET_V4_NAME}" "${ip}" >/dev/null 2>&1 || log_message "Warning: failed add IPv4 ${ip}"
    fi
  done

  return 0
}

fetch_once() {
  curl -sS -m 15 -H "X-Router-Secret: ${SHARED_SECRET_ROUTER}" "${SYNC_URL}"
}

long_poll_once() {
  local since="$1"
  curl -sS -m "${LONG_POLL_TIMEOUT_SEC}" -H "X-Router-Secret: ${SHARED_SECRET_ROUTER}" "${LONG_POLL_URL}?since=${since}"
}

parse_last_updated() {
  local response="$1"
  echo "${response}" | jsonfilter -e '@.last_updated' -q 2>/dev/null
}

parse_status() {
  local response="$1"
  echo "${response}" | jsonfilter -e '@.status' -q 2>/dev/null
}

sync_latest_ips() {
  local resp
  resp="$(fetch_once)"
  if [ -z "${resp}" ]; then
    log_message "Warning: sync_latest_ips got empty response."
    return 1
  fi

  flush_and_load_ips "${resp}" || return 1

  local updated
  updated="$(parse_last_updated "${resp}")"
  if [ -n "${updated}" ]; then
    LAST_UPDATED="${updated}"
  fi
  log_message "Quick sync completed, last_updated=${LAST_UPDATED}"
  return 0
}

long_poll_loop() {
  local resp status updated
  while true; do
    resp="$(long_poll_once "${LAST_UPDATED}")"
    if [ -z "${resp}" ]; then
      log_message "Long poll failed/empty, retry in ${RETRY_WAIT_SEC}s."
      sleep "${RETRY_WAIT_SEC}"
      continue
    fi

    status="$(parse_status "${resp}")"
    updated="$(parse_last_updated "${resp}")"

    if [ -n "${updated}" ]; then
      LAST_UPDATED="${updated}"
    fi

    case "${status}" in
      updated|cleaned|current)
        flush_and_load_ips "${resp}"
        log_message "Applied IP list update from status=${status}, last_updated=${LAST_UPDATED}"
        ;;
      timeout)
        log_message "Long poll timeout with no change."
        ;;
      *)
        log_message "Unexpected status='${status}', response='${resp}'"
        ;;
    esac
  done
}

do_init() {
  check_config || exit 1
  require_commands || exit 1
  ensure_ipsets || exit 1
  sync_latest_ips || log_message "Warning: initial sync failed, continue anyway."
  log_message "Init done. Only ipsets are managed: ${IPSET_V4_NAME}, ${IPSET_V6_NAME}"
}

do_run() {
  check_config || exit 1
  require_commands || exit 1
  # If another instance already holds the lock, exit 0 to avoid procd respawn loop.
  acquire_run_lock || exit 0
  ensure_ipsets || exit 1
  sync_latest_ips || log_message "Warning: initial quick sync failed."
  log_message "Entering long-poll loop."
  long_poll_loop
}

case "${1:-}" in
  init)
    do_init
    ;;
  run)
    do_run
    ;;
  *)
    echo "Usage: $0 [init|run]"
    exit 1
    ;;
esac
