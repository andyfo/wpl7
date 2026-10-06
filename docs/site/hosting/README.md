# Hosting the docs under the website

The docs are static files. The `publish` job in `.github/workflows/docs.yml` copies the build
into the `/docs` directory of the WordPress site with `rsync` over SSH, then checks the live
site. This is the one-time setup on the website's server and in GitHub. Until it is done, the
job builds the site, says it is not set up, and stops without failing.

Commands below use `www.example.com` for the website, `/var/www/example` for its web root and
`docs-deploy` for the account that receives the files. Use your own.

## 1. The directory

```bash
sudo adduser --disabled-password --gecos 'WPL7 docs publishing' docs-deploy
```

```bash
sudo install -d -o docs-deploy -g www-data -m 2755 /var/www/example/docs
```

The directory belongs to the account that publishes. The web server only reads it, and
WordPress's PHP user needs no write access to it.

## 2. The key, allowed to write that directory and nothing else

Make a key for GitHub only, on your own machine:

```bash
ssh-keygen -t ed25519 -N '' -C 'wpl7-docs-publish' -f docs_deploy_key
```

On the server, give it to `docs-deploy` with a forced command. `rrsync` comes with rsync on
Debian and Ubuntu. `-wo` lets the key write into the directory and nothing else: no shell, no
reading, no other path.

```bash
sudo -u docs-deploy mkdir -p -m 700 /home/docs-deploy/.ssh
```

```bash
echo "restrict,command=\"rrsync -wo /var/www/example/docs\" $(cat docs_deploy_key.pub)" | sudo -u docs-deploy tee -a /home/docs-deploy/.ssh/authorized_keys
```

Check that the key cannot leave the directory. Both commands must be refused:

```bash
ssh -i docs_deploy_key docs-deploy@www.example.com id
```

```bash
rsync -e 'ssh -i docs_deploy_key' README.md 'docs-deploy@www.example.com:../outside.txt'
```

## 3. The web server

**Apache and LiteSpeed** need nothing more: `.htaccess` is published with the pages
(`public/.htaccess`). It turns WordPress's rewrite rules off inside `/docs`, serves the docs' own
404 page and sets the cache headers. The virtual host must allow `.htaccess` to do that
(`AllowOverride FileInfo Indexes Options`, or `All`).

**nginx** needs [`nginx.conf.snippet`](nginx.conf.snippet) in the WordPress site's `server`
block, before its `location /`. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. WordPress

- No page, post or plugin route may use the slug `docs`. The directory would still win on every
  web server, but editors and sitemaps would see two things at one address.
- Add the docs' sitemap to the site's robots output: in the SEO plugin's robots setting, or with a
  `robots_txt` filter.

  ```
  Sitemap: https://www.example.com/docs/sitemap-index.xml
  ```

- Leave page-cache plugins as they are. They cache WordPress's PHP pages, not files in `/docs`.
  A CDN in front of the site caches pages for at most five minutes, per the headers above.

## 5. The secrets in GitHub

**Settings → Secrets and variables → Actions → Secrets**:

| Secret | Value |
|---|---|
| `DOCS_DEPLOY_HOST` | `www.example.com` |
| `DOCS_DEPLOY_USER` | `docs-deploy` |
| `DOCS_DEPLOY_PORT` | `22`, or the server's SSH port |
| `DOCS_DEPLOY_PATH` | `.` with `rrsync`, which already names the directory |
| `DOCS_DEPLOY_SSH_KEY` | the contents of `docs_deploy_key`, the private half |
| `DOCS_DEPLOY_KNOWN_HOSTS` | the server's host key line, from the command below |

```bash
ssh-keyscan -p 22 www.example.com
```

Compare what it prints with the server's own key before you paste it:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

A different public address for the docs goes in **Variables** as `DOCS_PUBLIC_URL`, for
example `https://docs.example.com/docs/`. The default is `https://wpl7.com/docs/`.

Delete `docs_deploy_key` from your machine once it is in GitHub.

## 6. The first publish

**Actions → Docs → Run workflow**, on `main`, with **Publish the site** ticked. The run copies
the build and checks the live site: the start page carries the commit it was built from, a deep
page answers, the search index is served as JSON, and a missing page gets the docs' own 404.

After that, every merge to `main` that changes the docs or the code they document publishes
within a few minutes, and every published release republishes the site, which clears the Edge
badges of what it ships.

## Rotating the key

1. Make a new key as in step 2 and add its line to `authorized_keys`.
2. Replace `DOCS_DEPLOY_SSH_KEY` in GitHub, and run the workflow by hand to see it work.
3. Remove the old key's line from `authorized_keys`.

## What a failed publish leaves

`rsync` runs with `--delay-updates` and `--delete-delay`: new files arrive under temporary names
and are swapped in, and old ones removed, only once everything has arrived. A transfer that
fails leaves the previous site in place.
