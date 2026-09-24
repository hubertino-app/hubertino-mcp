#!/bin/sh
# Build an MCP Bundle (.mcpb) for Claude Desktop one-click install and for
# Smithery ("smithery mcp publish ./hubertino-mcp.mcpb -n <org>/<name>").
# Output: ./hubertino-mcp.mcpb (git-ignored). Needs network for npm install.
set -eu
cd "$(dirname "$0")/.."

npm run build
rm -rf bundle hubertino-mcp.mcpb
mkdir -p bundle
cp -R dist manifest.json package.json package-lock.json README.md LICENSE bundle/
(cd bundle && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes @anthropic-ai/mcpb@2 validate bundle/manifest.json
npx --yes @anthropic-ai/mcpb@2 pack bundle hubertino-mcp.mcpb
rm -rf bundle
echo "Built $(pwd)/hubertino-mcp.mcpb"
