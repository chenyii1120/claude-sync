'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CLAUDE_HOME = path.join(process.env.HOME, '.claude');
const SYNC_DIR = path.join(CLAUDE_HOME, 'sync');
const REPO_DIR = path.join(SYNC_DIR, 'repo');
const CONFIG_PATH = path.join(SYNC_DIR, 'config.json');
const MAPPING_PATH = path.join(SYNC_DIR, 'mapping.json');
const LAST_SYNC_PATH = path.join(SYNC_DIR, 'last-sync.json');
const BACKUP_DIR = path.join(CLAUDE_HOME, 'sync-backups');

// Placeholder — functions will be added in subsequent tasks
module.exports = { CLAUDE_HOME, SYNC_DIR, REPO_DIR, CONFIG_PATH, MAPPING_PATH, LAST_SYNC_PATH, BACKUP_DIR };
