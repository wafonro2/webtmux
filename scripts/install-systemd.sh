#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="webtmux"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/${SERVICE_NAME}.env"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${WEBTMUX_USER:-${SUDO_USER:-$USER}}"
PORT="${WEBTMUX_PORT:-3001}"
RUN_USER_SHELL="$(getent passwd "${RUN_USER}" | cut -d: -f7 || true)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo/root: sudo ./scripts/install-systemd.sh" >&2
  exit 1
fi

if ! id "${RUN_USER}" >/dev/null 2>&1; then
  echo "User '${RUN_USER}' does not exist." >&2
  exit 1
fi

if [[ -z "${RUN_USER_SHELL}" || ! -x "${RUN_USER_SHELL}" ]]; then
  RUN_USER_SHELL="/bin/bash"
fi

if [[ -z "${WEBTMUX_PASSWORD:-}" ]]; then
  read -r -s -p "Enter WEBTMUX_PASSWORD for webtmux: " WEBTMUX_PASSWORD
  echo
fi

if [[ -z "${WEBTMUX_PASSWORD:-}" ]]; then
  echo "WEBTMUX_PASSWORD cannot be empty." >&2
  exit 1
fi

read_required_node_major() {
  local default_major="${WEBTMUX_NODE_MAJOR:-20}"
  if [[ -f "${APP_DIR}/.nvmrc" ]]; then
    local raw
    raw="$(tr -d '[:space:]' < "${APP_DIR}/.nvmrc")"
    if [[ "${raw}" =~ ^([0-9]+) ]]; then
      echo "${BASH_REMATCH[1]}"
      return
    fi
  fi
  echo "${default_major}"
}

find_user_bin() {
  local binary_name="$1"
  local override_path="$2"

  if [[ -n "${override_path}" ]]; then
    if [[ -x "${override_path}" ]]; then
      echo "${override_path}"
      return 0
    fi
    echo "Configured path for ${binary_name} is not executable: ${override_path}" >&2
    return 1
  fi

  local detected
  detected="$(su - "${RUN_USER}" -s "${RUN_USER_SHELL}" -c "command -v ${binary_name}" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${detected}" && -x "${detected}" ]]; then
    echo "${detected}"
    return 0
  fi

  return 1
}

NODE_BIN="$(find_user_bin node "${WEBTMUX_NODE_BIN:-}" || true)"
NPM_BIN="$(find_user_bin npm "${WEBTMUX_NPM_BIN:-}" || true)"
TMUX_BIN="$(find_user_bin tmux "${WEBTMUX_TMUX_BIN:-}" || true)"

if [[ -z "${NODE_BIN}" || -z "${NPM_BIN}" || -z "${TMUX_BIN}" ]]; then
  echo "Failed to locate required binaries for user '${RUN_USER}'." >&2
  echo "Detected values:" >&2
  echo "  node: ${NODE_BIN:-<missing>}" >&2
  echo "  npm : ${NPM_BIN:-<missing>}" >&2
  echo "  tmux: ${TMUX_BIN:-<missing>}" >&2
  echo "If node/npm come from nvm, ensure they are available in the user's login shell," >&2
  echo "or pass explicit paths via WEBTMUX_NODE_BIN and WEBTMUX_NPM_BIN." >&2
  exit 1
fi

REQUIRED_NODE_MAJOR="$(read_required_node_major)"
NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt "${REQUIRED_NODE_MAJOR}" ]]; then
  echo "Detected node binary is not compatible: ${NODE_BIN} ($("${NODE_BIN}" -v 2>/dev/null || echo 'unknown'))." >&2
  echo "Node.js ${REQUIRED_NODE_MAJOR}+ is required." >&2
  echo "Set WEBTMUX_NODE_BIN/WEBTMUX_NPM_BIN to Node ${REQUIRED_NODE_MAJOR}+ paths if needed." >&2
  exit 1
fi

SERVICE_PATH="$(dirname "${NODE_BIN}"):$(dirname "${TMUX_BIN}"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/games"

echo "Building webtmux in ${APP_DIR} as ${RUN_USER} ..."
sudo -u "${RUN_USER}" env "PATH=${SERVICE_PATH}" "${NPM_BIN}" --prefix "${APP_DIR}" ci
sudo -u "${RUN_USER}" env "PATH=${SERVICE_PATH}" "${NPM_BIN}" --prefix "${APP_DIR}" run build
sudo -u "${RUN_USER}" env "PATH=${SERVICE_PATH}" "${NPM_BIN}" --prefix "${APP_DIR}" prune --omit=dev

echo "Writing ${ENV_FILE} ..."
cat > "${ENV_FILE}" <<ENVEOF
NODE_ENV=production
PORT=${PORT}
WEBTMUX_PASSWORD=${WEBTMUX_PASSWORD}
ENVEOF
chmod 600 "${ENV_FILE}"
chown root:root "${ENV_FILE}"

echo "Writing ${SYSTEMD_UNIT} ..."
cat > "${SYSTEMD_UNIT}" <<UNITEOF
[Unit]
Description=webtmux local web terminal frontend
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=PATH=${SERVICE_PATH}
ExecStart=${NODE_BIN} server/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
UNITEOF

echo "Reloading systemd and enabling ${SERVICE_NAME}.service ..."
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo
systemctl --no-pager --full status "${SERVICE_NAME}.service" | sed -n '1,25p'
echo

echo "Install complete."
echo "Service: ${SERVICE_NAME}.service"
echo "URL: http://localhost:${PORT}"
echo "Commands:"
echo "  sudo systemctl restart ${SERVICE_NAME}.service"
echo "  sudo journalctl -u ${SERVICE_NAME}.service -f"
