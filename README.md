# WordPress Theme Deployment Tool

Deploys a WordPress theme from your local environment to a remote server over SSH, and gives you a WP-CLI gateway to the same server. One `config.json` drives everything.

| What | Command | Transport |
|---|---|---|
| Deploy (incremental, ZIP for large sets) | `bun run deploy` | SFTP (ssh2) |
| Watch & sync while developing | `bun run sync` | SFTP (ssh2) |
| Pull the server's theme into `.backsync/` | `bun run pull` | SFTP (ssh2) |
| Deploy via rsync — dry run / apply | `bun run deploy:rsync:dry` / `bun run deploy:rsync` | rsync over ssh |
| Run WP-CLI on the server | `bash wp-staging.sh <wp args>` (or `bun run wp <wp args>`) | ssh exec |
| One-off file operations | `bun run tools/<script>.ts` | SFTP (ssh2) |

## Quick start in a new project

```bash
# 1. Add the tool to the theme (it is gitignored by the theme, it's its own repo)
cd wp-content/themes/<your-theme>
git clone https://github.com/CTOHacon/wordpress-theme-deployment-tool .deployment
echo ".deployment" >> .gitignore

# 2. Install and configure
cd .deployment
bun install
cp config-template.json config.json      # fill in ssh + remote_theme_path

# 3. Check the connection, then deploy
bash wp-staging.sh option get home       # WP-CLI answers → ssh + paths are right
bun run deploy:rsync:dry                 # see what would be transferred
bun run deploy:rsync                     # or: bun run deploy (sftp)
```

Which transport to pick:

- **SFTP (`bun run deploy`)** — works with password auth and on Windows (no rsync needed); has `sync` watch mode and `pull`.
- **rsync (`bun run deploy:rsync`)** — needs key auth and a local `rsync`; required when the host disables the sftp subsystem (**Flywheel** does — the SFTP tool can't connect there at all). Faster deltas.

Both read the same `ssh` block and `exclude` list, so you can switch freely.

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
- **`remote_wp_root`** *(optional)*: WordPress root on the server, where `wp-staging.sh` runs WP-CLI and `tools/upload-media.ts` finds `wp-content/uploads`. Leave empty to derive it from `remote_theme_path` (everything before `/wp-content/`).

#### Exclusions (`exclude`)

An array of glob patterns for files/folders to exclude from deployment:
- Use `**/pattern` for recursive exclusion
- Supports standard glob patterns

#### Deployment Steps (`deployment.steps`)

Optional commands to run on the remote server after deployment (both the SFTP deploy and `deploy.sh --apply` run them; `{remote_theme_path}` is substituted):
- **`composerInstall`**: Command to install/update Composer dependencies
  - Default: `cd {remote_theme_path}/ThemeCore && composer install`

**Hosts without Composer (e.g. Flywheel):** remove `**/vendor` and `vendor` from `exclude` so the locally installed `vendor/` ships with the theme, and set `"steps": {}`. Keep `vendor/php-stubs` excluded (dev-only, large).

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

### rsync Deploy (`deploy.sh`)

```bash
bun run deploy:rsync:dry        # ./deploy.sh            — dry run, prints what would change
bun run deploy:rsync            # ./deploy.sh --apply    — transfer
./deploy.sh --apply --delete    # also remove remote files that no longer exist locally
```

Reads `ssh.host/port/username/privateKey`, `remote_theme_path`, `local_theme_path` and `exclude` from `config.json` (needs `python3` for JSON parsing; macOS ships it). Key auth only — `BatchMode=yes`, a password prompt would just fail.

On `--apply` it additionally:

1. **Mirrors `source/build/`** with `--delete` (if that directory exists). Vite emits content-hashed filenames and a plain rsync only adds, so old builds pile up on the server. A theme that resolves assets by glob (`source/build/asset.app-*.css`, first match) can then keep serving a superseded build whose hash sorts first — it looks exactly like "the deploy didn't work". Only that directory is mirrored; everything in it is a regenerated artifact.
2. **Deletes `theme-require-mapping.json`** on the server — the HACON path cache stores absolute paths, and a copy from another machine fatals the site. The server regenerates its own.
3. **Runs `deployment.steps`** over ssh.

> `deploy.sh` ships **source only**. Seeders, options and media are data: run them on the server yourself (see below).

### WP-CLI Gateway (`wp-staging.sh`)

Runs `wp` in `remote_wp_root` on the deploy target — same ssh credentials as the deploy:

```bash
bash .deployment/wp-staging.sh option get home
bash .deployment/wp-staging.sh cache flush
bash .deployment/wp-staging.sh eval-file - < seeders/my-seeder.php   # run a local PHP file on the server
```

Arguments are shell-quoted before being sent, so values with spaces are safe. This is the one door for every read/write against the remote database — use it to run seeders there after deploying them.

### One-off Tools (`tools/`)

Small SFTP scripts sharing `tools/config.ts` (reads `config.json`, loads the private key file, resolves `remote_wp_root`):

| Script | Usage |
|---|---|
| `tools/probe.ts` | `bun run tools/probe.ts` — print the SFTP home dir and `wp-content/themes` listing (finds `remote_theme_path` on an unknown host) |
| `tools/put-one.ts` | `bun run tools/put-one.ts <local> <remote>` — upload one file, list same-stem siblings first |
| `tools/rm-one.ts` | `bun run tools/rm-one.ts <remote>` — delete one remote file and confirm it's gone |
| `tools/upload-dir.ts` | `bun run tools/upload-dir.ts <localDir> <remoteDir>` — upload a directory tree |
| `tools/upload-media.ts` | `bun run tools/upload-media.ts` — push local `wp-content/uploads` to the server, skipping same-size files |

These need a host with sftp enabled (not Flywheel).

### Pull (`bun run pull`)

Downloads the server's theme into `.backsync/` (gitignored) for diffing against local source — useful when someone edited files directly on the server. Ignores `exclude` (so `.scss`/`.ts` come down too); skips `.git`, `node_modules`, `vendor`, `.deployment`.

### SFTP Deploy

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

### SFTP: "subsystem request failed" / connection closes right after auth

**Problem:** The host disables the sftp subsystem (Flywheel's SSH gateway does). `bun run deploy`, `sync`, `pull` and `tools/` cannot work there.

**Solution:** Use `bun run deploy:rsync` and `wp-staging.sh` — both run over a plain ssh exec channel.

### Deploy "did nothing" — page still shows old CSS/JS

**Problem:** New files arrived, but the page still loads a previous build.

**Solutions:**
- Check `ls source/build/asset.app-*.css` on the server: more than one file means superseded hashed builds are shadowing the current one. `deploy.sh --apply` mirrors that directory — redeploy with it
- Host page cache (Flywheel, WP Engine, …): purge it, or add a purge command to `deployment.steps`

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

1. **Never commit `config.json` or keys** - `config.json`, `id_rsa*`, `id_ed25519*`, `ssh_key*` are gitignored; keep a project key next to `config.json` under one of those names
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

Then add `package.json` scripts (`wp-staging.sh` and `deploy.sh` always read `config.json`, so copy first for them too):

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
