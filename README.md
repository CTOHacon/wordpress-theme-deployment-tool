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

Once configured, deploy your theme with:

```bash
bun run deploy
```

### What Happens During Deployment

1. **Connection**: Establishes SSH/SFTP connection to remote server
2. **File Collection**: Gathers local files (excluding patterns from `exclude`)
3. **Remote Cleanup**: Lists and removes outdated files on remote server
4. **Upload**: Transfers files via SFTP (or ZIP for large deployments)
5. **Post-Deployment**: Runs configured commands (e.g., `composerInstall`)

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

### Environment-Specific Configurations

Create multiple config files for different environments:

- `config.staging.json`
- `config.production.json`

Then modify `package.json` scripts:

```json
{
    "scripts": {
        "deploy": "bun run src/index.ts",
        "deploy:staging": "cp config.staging.json config.json && bun run deploy",
        "deploy:production": "cp config.production.json config.json && bun run deploy"
    }
}
```