# WordPress Theme Deployment Tool

A TypeScript-based deployment tool for WordPress themes that uses SSH/SFTP to sync files from your local environment to a remote server.

## Installation

```bash
bun install
```

## Configuration

### Setup

Copy the template configuration file to create your own:

```bash
cp config-template.json config.json
```

**Important:** The `config.json` file is gitignored to keep your credentials secure.

### Configuration Structure

The `config.json` file contains the following sections:

#### SSH Connection (`ssh`)

Configure your SSH connection with one of the authentication methods below.

#### Paths

- **`remote_theme_path`**: The absolute path to your theme directory on the remote server
  - Example: `/var/www/html/wp-content/themes/my-theme`
- **`local_theme_path`**: The relative path to your local theme (default: `../`)

#### Exclusions (`exclude`)

An array of glob patterns for files/folders to exclude from deployment:
- Use `**/pattern` for recursive exclusion
- Supports standard glob patterns

#### Deployment Steps (`deployment.steps`)

Optional commands to run on the remote server after deployment:
- **`composerInstall`**: Command to install/update Composer dependencies
  - Default: `cd {remote_theme_path}/ThemeCore && composer install`

---

## Authentication Methods

The tool supports multiple SSH authentication methods. Choose the one that matches your server setup:

### Method 1: Password Authentication

**When to use:** Basic SSH access with username and password.

```json
{
    "ssh": {
        "host": "example.com",
        "port": 22,
        "username": "your_username",
        "password": "your_password"
    },
    "remote_theme_path": "/var/www/html/wp-content/themes/my-theme",
    "local_theme_path": "../"
}
```

**Note:** Remove or leave empty `privateKey` and `passphrase` fields.

---

### Method 2: SSH Key (No Passphrase)

**When to use:** Key-based authentication without a passphrase (more secure than password).

```json
{
    "ssh": {
        "host": "example.com",
        "port": 22,
        "username": "your_username",
        "privateKey": "/Users/username/.ssh/id_rsa"
    },
    "remote_theme_path": "/var/www/html/wp-content/themes/my-theme",
    "local_theme_path": "../"
}
```

**Notes:**
- Use absolute path to your private key file
- Common locations: `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`
- Remove or leave empty `password` and `passphrase` fields

---

### Method 3: SSH Key with Passphrase

**When to use:** Key-based authentication with a passphrase (most secure option).

```json
{
    "ssh": {
        "host": "example.com",
        "port": 22,
        "username": "your_username",
        "privateKey": "/Users/username/.ssh/id_rsa",
        "passphrase": "your_key_passphrase"
    },
    "remote_theme_path": "/var/www/html/wp-content/themes/my-theme",
    "local_theme_path": "../"
}
```

**Notes:**
- The passphrase is for unlocking your private key, not your server password
- Remove or leave empty `password` field

---

### Method 4: Custom SSH Port

**When to use:** Server uses non-standard SSH port.

```json
{
    "ssh": {
        "host": "example.com",
        "port": 2222,
        "username": "your_username",
        "password": "your_password"
    },
    "remote_theme_path": "/var/www/html/wp-content/themes/my-theme",
    "local_theme_path": "../"
}
```

---

## Complete Configuration Example

Here's a full example with all options configured:

```json
{
    "ssh": {
        "host": "staging.mywebsite.com",
        "port": 22,
        "username": "deploy_user",
        "privateKey": "/Users/john/.ssh/id_ed25519",
        "passphrase": "my_key_passphrase"
    },
    "remote_theme_path": "/var/www/staging/wp-content/themes/my-theme",
    "local_theme_path": "../",
    "exclude": [
        ".git",
        ".deployment",
        "**/node_modules",
        "**/vendor",
        "docs",
        ".gitignore",
        "package-lock.json",
        "composer.lock",
        "source/dev",
        "**/vite.config.js",
        "**/tsconfig.json",
        "**/*.scss",
        "**/*.ts",
        "gutenberg/src",
        "**/*.jsx"
    ],
    "deployment": {
        "steps": {
            "composerInstall": "cd {remote_theme_path} && composer install --no-dev --optimize-autoloader"
        }
    }
}
```

---

## Usage

### One-Time Deployment

Deploy your theme once with:

```bash
bun run deploy
```

### Local Update Times (`--local-times`)

By default, changed files are detected by comparing local modification times
against the mtimes reported by the server. Some servers do not preserve (or do
not allow setting) modification times on upload — remote mtimes then reflect
upload time and the comparison becomes unreliable.

The `--local-times` flag switches change detection to a local snapshot:

```bash
bun run deploy --local-times
```

- After each successful deploy, the current file tree (paths, mtimes, sizes)
  is stored in `.mtime-snapshot.json` (gitignored, next to `config.json`).
- The next deploy compares against that snapshot instead of remote mtimes,
  and **skips the slow recursive remote file listing entirely** — both changed
  files and deletions are derived from the snapshot. This is where the speed
  win comes from.
- Uploads also skip setting the remote file's mtime (`sftp utimes`) — remote
  times aren't used for comparison in this mode, and some servers (e.g.
  WP Engine) reject setstat with "Could not set mtime" warnings.
- Trade-off: changes made on the server by someone else are invisible to the
  snapshot. Run a plain `bun run deploy` occasionally to reconcile drift.
- Snapshots are keyed per deploy target (`ssh.host` + `remote_theme_path`),
  so swapping `config.json` between targets is safe.
- The first run for a target (no snapshot yet) falls back to the remote
  comparison for that run, then records the snapshot.
- A failed deploy never updates the snapshot.

Also works with `bun run sync --local-times` (applies to the initial full
sync; the watcher itself tracks changes by content hash).

### SYNC Mode - Continuous File Watching

For active development, use SYNC mode to automatically sync file changes to the server:

```bash
bun run sync
```

**What SYNC mode does:**

1. **Initial Full Sync**: Performs a complete deployment first (same as `bun run deploy`)
2. **Watch Mode**: Starts monitoring your `local_theme_path` for file changes
3. **Auto-Sync**: Automatically uploads/deletes changed files to the remote server
4. **Real-time Updates**: Changes are synced within ~500ms of detection
5. **Persistent Connection**: Keeps SSH connection alive until you stop it

**To stop SYNC mode:**
- Press `Ctrl+C` to gracefully shutdown the watcher and close SSH connection

**Best for:**
- Active theme development
- Quick iteration and testing
- Instant preview of changes on staging server
- Frontend development workflow

**Note:** SYNC mode respects all `exclude` patterns from your config.json

### What Happens During Deployment

1. **Connection**: Establishes SSH/SFTP connection to remote server
2. **File Collection**: Gathers local files (excluding patterns from `exclude`)
3. **Remote Cleanup**: Lists and removes outdated files on remote server
4. **Upload**: Transfers files via SFTP (or ZIP for large deployments)
5. **Post-Deployment**: Runs configured commands (e.g., `composerInstall`)

### What Happens During SYNC Mode

1. **Initial Full Deployment**: Same as above (steps 1-5)
2. **File Indexing**: Scans and indexes all existing files to establish baseline content hashes
3. **File Watcher Activation**: Monitors `local_theme_path` directory recursively
4. **Change Detection**: Detects file additions, modifications, and deletions
5. **Content Hash Verification**: Compares SHA-256 hash of file content to detect actual changes
6. **Debouncing**: Groups rapid changes together (500ms delay)
7. **Incremental Sync**:
   - **Added/Modified files**: Uploaded to remote server only if content actually changed
   - **Deleted files**: Removed from remote server immediately
   - **Skipped files**: Files with only timestamp changes (no content change) are skipped
8. **Continuous Monitoring**: Keeps running until manually stopped
9. **Graceful Shutdown**: Properly closes watchers and SSH connection on exit

**SYNC Mode Features:**
- **Initial file indexing**: Builds baseline hash map on startup to prevent unnecessary first-save uploads
- **Parallel processing**: Files are indexed and synced in parallel for maximum speed
- **Content-based change detection**: Only syncs files when content actually changes, not just timestamp
- **SHA-256 hashing**: Fast and reliable content comparison
- **Debounced updates**: Prevents sync spam during bulk operations (e.g., git checkout)
- **Exclude patterns respected**: Only tracks files not in exclude list
- **Error resilience**: Individual file sync failures don't crash the watcher
- **Path normalization**: Handles Windows/Unix path differences automatically
- **Smart directory handling**: Detects and syncs directory structure changes
- **Memory efficient**: Tracks file hashes in memory for quick comparison

---

## Troubleshooting

### Permission Denied (publickey)

**Problem:** SSH key authentication fails

**Solutions:**
- Verify the private key path is correct and absolute
- Ensure the key has proper permissions: `chmod 600 ~/.ssh/id_rsa`
- Check that your public key is in the server's `~/.ssh/authorized_keys`
- Verify you're using the correct username

### Connection Timeout

**Problem:** Cannot connect to server

**Solutions:**
- Verify the host and port are correct
- Check if SSH port is accessible: `telnet example.com 22`
- Ensure firewall allows SSH connections
- Try connecting manually: `ssh username@example.com -p 22`

### Wrong Passphrase

**Problem:** SSH key passphrase is incorrect

**Solutions:**
- Verify the passphrase in your config.json
- Test the key manually: `ssh -i ~/.ssh/id_rsa username@example.com`
- Consider using ssh-agent to cache the passphrase

### Upload Fails

**Problem:** Files cannot be uploaded to remote path

**Solutions:**
- Verify `remote_theme_path` exists and is writable
- Check directory permissions on remote server
- Ensure your user has write access to the theme directory

### SYNC Mode Not Detecting Changes

**Problem:** File changes aren't being synced

**Solutions:**
- Verify the file isn't in the `exclude` patterns
- Check that SYNC mode is still running (look for the watching message)
- Ensure the SSH connection hasn't dropped (restart SYNC mode)
- On some systems, verify that recursive file watching is supported
- Try saving the file again (some editors use atomic writes)

### SYNC Mode Uploading on Every Save (Even Without Changes)

**Problem:** Files are uploaded every time you save, even when content hasn't changed

**Solution:** This is now fixed! The sync tool uses SHA-256 content hashing to detect actual changes. You should see:
- **"SKIP No content change: filename"** - File was saved but content is identical
- **"SYNC Uploading: filename"** - File content actually changed and will be uploaded

**How it works:**
1. On startup, SYNC mode indexes all existing files and creates baseline hashes
2. When you save a file, it compares the new hash with the baseline
3. Only uploads if the content hash differs
4. Even the first save after starting SYNC mode won't upload if content is unchanged

### SYNC Mode Syncing Too Many Files

**Problem:** Unwanted files are being synced

**Solutions:**
- Add more specific patterns to your `exclude` list
- Check for hidden files like `.DS_Store` or editor temp files
- Add `**/*.log`, `**/*.tmp`, `**/.*.swp` to excludes
- Verify `node_modules` and `vendor` are properly excluded

---

## Security Best Practices

1. **Never commit `config.json`** - It's gitignored by default, keep it that way
2. **Use SSH keys over passwords** - More secure and convenient
3. **Protect your private keys** - Set proper permissions (`chmod 600`)
4. **Use passphrase-protected keys** - Extra layer of security
5. **Limit deployment user permissions** - Grant only necessary access on the server
6. **Use separate keys for different environments** - Don't reuse production keys

---

## Advanced Configuration

### Custom Deployment Commands

You can add custom post-deployment commands:

```json
{
    "deployment": {
        "steps": {
            "composerInstall": "cd {remote_theme_path} && composer install",
            "clearCache": "cd {remote_theme_path} && wp cache flush",
            "restartServices": "sudo systemctl restart php-fpm"
        }
    }
}
```

**Note:** Custom deployment commands only run during initial deployment, not on individual file changes in SYNC mode.

### Environment-Specific Configurations

Create multiple config files for different environments:

- `config.staging.json`
- `config.production.json`

Then modify `package.json` scripts:

```json
{
    "scripts": {
        "deploy": "bun run src/index.ts",
        "sync": "bun run src/index.ts --sync",
        "deploy:staging": "cp config.staging.json config.json && bun run deploy",
        "deploy:production": "cp config.production.json config.json && bun run deploy",
        "sync:staging": "cp config.staging.json config.json && bun run sync"
    }
}
```

### SYNC Mode with Specific Excludes

For SYNC mode, you might want to exclude additional files that change frequently but shouldn't trigger syncs:

```json
{
    "exclude": [
        ".git",
        ".deployment",
        "**/node_modules",
        "**/vendor",
        "**/*.log",
        "**/*.tmp",
        "**/.DS_Store",
        "**/debug.log",
        "**/*.map"
    ]
}
```

### Development Workflow Examples

**Scenario 1: Frontend Development on Staging**
```bash
# Use SYNC mode for instant preview of CSS/JS changes
bun run sync:staging
```

**Scenario 2: Production Deployment**
```bash
# One-time full deployment to production
bun run deploy:production
```

**Scenario 3: Quick Theme Update**
```bash
# Deploy without comparing remote files (faster)
bun run src/index.ts --skip-compair
```