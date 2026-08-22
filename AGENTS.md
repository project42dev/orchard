# Project 42 Orchard — Agent Instructions

## What this repo is
This private repository contains the autonomous content maintenance factory and Azure Container Apps automation engine. It monitors frontier sources, runs adversarial AI ensembles in Azure AI Foundry, and prepares Gate 1 / Gate 2 proposals.

## Start here
Use the HCS Governance MCP server as the standards source of truth:
```text
bootstrap(repo="orchard", client="<client>")
```

## Hard rules
1. Never commit secrets, API keys, connection strings, or Azure subscription IDs.
2. All secrets live in Azure Key Vault (`kv-p42-orchard-prod-eus-01`).
3. Scripts must be PowerShell 7+ (`#Requires -Version 7.0`) with `Set-StrictMode -Version Latest`.
4. State is persisted to private lease-locked SQLite databases in Azure Blob Storage.
5. Commit format: `type(scope): description (AB#<id>)`.
