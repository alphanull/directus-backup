# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org) and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [Unreleased]

### Fixed

- Add-on Compose examples (README quick start, `installation.md` step 1, `examples/docker-compose.backup.yml`) referenced an undefined `internal` network, which broke `docker compose` when merged into a stack on the default network

### Changed

- Clarified network-security docs: not publishing port 4700 is the ingress control; `internal: true` is optional egress hardening

---

## [0.9.0] – 2026-06-06

### Added

- This marks the first release of **Directus Backup**
- **Localized UI** — full-featured backup module built into Directus Studio, currently available in English and German
- **Complete Directus backups** — database, uploads, and extensions in a single archive
- **Selective scope** — choose which components to include, exclude specific collections
- **Scheduled backups** — configurable intervals (hourly to weekly) with automatic retention
- **Import & Export Backups** — Download and upload backups (must be enabled manually)
- **Full & partial restore** — restore the entire system or individual collections directly from the UI
- **Integrity verification** — SHA-256 checksums + row-count comparison on every restore
- **Disaster recovery** — CLI restore script works without Directus Studio
- **Storage management** — quota limits, free-space checks, automatic rotation
- **Pluggable DB adapters** — PostgreSQL built-in, extensible for MySQL/SQLite
- **Activity Logs** — Keep track of all operations
- **Admin notifications** — in-app alerts on scheduled backup failures
