#!/usr/bin/env bash
set -euo pipefail

REPO="nikuscs/codex-cc-plugin"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="claude-codex"
SHORT_ALIAS="ccx"
VERSION="${1:-latest}"

usage() {
  cat <<'EOF'
Usage: install.sh [version]

Examples:
  curl -fsSL https://raw.githubusercontent.com/nikuscs/codex-cc-plugin/main/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/nikuscs/codex-cc-plugin/main/scripts/install.sh | bash -s -- v0.1.0
EOF
}

if [[ "${VERSION}" == "--help" || "${VERSION}" == "-h" ]]; then
  usage
  exit 0
fi

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ "${VERSION}" == "latest" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  if [[ -z "${VERSION}" ]]; then
    echo "Could not resolve latest release tag" >&2
    exit 1
  fi
fi

mkdir -p "${INSTALL_DIR}"

artifact="${BINARY_NAME}-${os}-${arch}"
url="https://github.com/${REPO}/releases/download/${VERSION}/${artifact}"
tmp_file="$(mktemp)"

echo "Downloading ${artifact} from ${VERSION}..."
curl -fL "${url}" -o "${tmp_file}"
chmod +x "${tmp_file}"
mv "${tmp_file}" "${INSTALL_DIR}/${BINARY_NAME}"
ln -sf "${INSTALL_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${SHORT_ALIAS}"

echo ""
echo "${BINARY_NAME} installed to ${INSTALL_DIR}/${BINARY_NAME}"
echo "${SHORT_ALIAS} installed to ${INSTALL_DIR}/${SHORT_ALIAS}"
echo "Add ${INSTALL_DIR} to PATH if needed."
