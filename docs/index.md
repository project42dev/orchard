# Orchard Public Documentation

Welcome to the official technical and operational documentation for **Orchard**, the autonomous content discovery, currency maintenance, and delivery platform for Project 42.

---

## 📚 Core Documentation Index

| Document | Description |
| :--- | :--- |
| [**Architecture & Design Guide**](architecture.md) | Comprehensive system design, trust boundaries, multi-model ensemble, and Azure topology. |
| [**Operations & Runbook**](operations.md) | Operator guide: manual triggers, reviewing human gates, Log Analytics monitoring, image deployments. |
| [**Content Lifecycle & State Machine**](lifecycle.md) | 14-state formal workflow machine, Gate 1 & Gate 2 protocols, rework loops, and transitions. |
| [**Hosting Architecture Diagram**](hosting-architecture.mmd) | Visual Mermaid architecture diagram of the Azure Container Apps environment and external services. |
| [**Installation & Local Setup**](install.md) | Environment prerequisites, configuration maps, and local test execution. |
| [**Repository Boundary Contract**](../REPO-BOUNDARY.md) | Strict definitions of what belongs in Orchard versus public learning platforms. |

---

## ⚡ Quick Reference

- **Azure Resource Group**: `rg-p42-orchard-prod-eus-01` (East US)
- **Container Apps Environment**: `cae-p42-orchard-prod-eus-01`
- **Container Registry**: `crp42orchprodeus01.azurecr.io/orchard:latest`
- **State Store**: `stp42orchstateprodeus01/orchard-state` (`orchard.db` with lease locking)
- **Model Map Configuration**: `config/model-map.json`
- **Approved Source Registry**: `seed-inputs/approved-source-registry.json`
- **Live Learning Platform**: `https://learn.project42.dev`
