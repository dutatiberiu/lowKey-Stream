# lowKey-Stream - Setup Guide

## Prerequisites

- **Python 3.8+** instalat pe PC-ul de acasă
- **cloudflared** instalat pe PC-ul de acasă
- **GitHub account** cu un Personal Access Token
- **Filme** într-un folder local (default: `D:\Filme`)

---

## Pas 1: Instalează cloudflared

Deschide PowerShell/CMD și rulează:

```
winget install Cloudflare.cloudflared
```

Sau descarcă manual de la: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Verifică instalarea:
```
cloudflared --version
```

---

## Pas 2: Creează GitHub Repository

1. Du-te pe https://github.com/new
2. Nume repo: `lowKey-Stream`
3. Public (ca GitHub Pages să funcționeze gratuit)
4. Creează repo-ul

---

## Pas 3: Creează GitHub Personal Access Token

1. Du-te la https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Nume: `lowKey-Stream`
4. Expiration: 90 days (sau "No expiration" dacă vrei permanent)
5. Scopes: bifează **`repo`** (Full control of private repositories)
6. Click **"Generate token"**
7. **Copiază token-ul** (nu-l mai poți vedea după ce închizi pagina!)

---

## Pas 4: Configurează proiectul

### 4.1 Clone repo-ul
```bash
cd C:\Users\Tibi\Desktop\Projects
git clone https://github.com/dutatiberiu/lowKey-Stream.git
cd lowKey-Stream
```

### 4.2 Copiază fișierele frontend în repo
Fișierele din `frontend/` (index.html, app.js, styles.css, config.json) trebuie să fie în repo.

### 4.3 Configurează serverul
```bash
cd server
copy config.example.json config.json
```

Editează `server/config.json`:
```json
{
    "video_folder": "D:\\Filme",
    "server_port": 8080,
    "github_token": "ghp_PASTE_YOUR_TOKEN_HERE",
    "github_repo": "dutatiberiu/lowKey-Stream",
    "github_config_path": "frontend/config.json",
    "supported_extensions": [".mp4", ".mkv", ".avi", ".mov", ".webm"],
    "browser_playable": [".mp4", ".webm"],
    "health_check_interval": 60
}
```

**IMPORTANT:** `server/config.json` este în `.gitignore` - NU va fi comis în repo (conține token-ul tău secret).

---

## Pas 5: Push la GitHub

```bash
cd C:\Users\Tibi\Desktop\Projects\lowKey-Stream
git add .
git commit -m "Initial setup"
git push origin main
```

---

## Pas 6: Activează GitHub Pages

1. Du-te la repo pe GitHub → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**
4. Folder: **/ (root)** sau **/frontend** (depinde de structura repo-ului)
   - Dacă fișierele frontend sunt direct în root → alege **/ (root)**
   - Dacă sunt în folderul `frontend/` → alege **/frontend** (dacă opțiunea nu e disponibilă, mută fișierele în `/docs` și alege **/docs**)
5. Click **Save**
6. Așteaptă 1-2 minute pentru deploy

**Nota:** Dacă GitHub Pages nu suportă folderul `/frontend`, cea mai simplă soluție este să copiezi fișierele frontend direct în rădăcina repo-ului. Scriptul Python va actualiza `config.json` la path-ul specificat în `github_config_path`.

URL-ul va fi: `https://dutatiberiu.github.io/lowKey-Stream/`

---

## Pas 7: Pornește Serverul

Pe PC-ul de acasă:
```bash
cd C:\Users\Tibi\Desktop\Projects\lowKey-Stream\server
python stream_server.py
```

Ar trebui să vezi:
```
============================================================
  lowKey-Stream Server v1.0
============================================================

>> Loading config...
[OK] Config loaded (port: 8080)

>> Scanning D:\Filme for video files...
[OK] Found 47 videos (32 browser-playable, 15 need conversion)

>> Starting HTTP server on port 8080...
[OK] Server running at http://localhost:8080

>> Starting Cloudflare tunnel...
[OK] Tunnel active: https://random-words.trycloudflare.com

>> Updating GitHub config.json...
[OK] GitHub Pages config updated successfully

============================================================
  Server is LIVE!
  Local:  http://localhost:8080
  Tunnel: https://random-words.trycloudflare.com
  Press Ctrl+C to stop.
============================================================
```

---

## Pas 8: Accesează de pe laptop

Deschide: `https://dutatiberiu.github.io/lowKey-Stream/`

Ar trebui să vezi lista de filme și status "Connected".

---

## Troubleshooting

### "Server offline" pe frontend
- Verifică că `stream_server.py` rulează pe PC-ul de acasă
- Verifică output-ul script-ului - a pornit tunnel-ul?
- Refreshează pagina (tunnel URL se schimbă la fiecare restart)

### Filmele nu pornesc
- Verifică dacă e format MP4/WebM (browserul le suportă nativ)
- MKV/AVI pot să nu meargă - convertește cu:
  ```
  ffmpeg -i "D:\Filme\film.mkv" -codec copy "D:\Filme\film.mp4"
  ```
  (`-codec copy` face remux fără re-encode, e instant)

### "cloudflared not found"
- Reinstalează: `winget install Cloudflare.cloudflared`
- Sau adaugă manual la PATH

### GitHub API error 401
- Token-ul a expirat sau e greșit
- Generează un token nou (Pas 3)

### Zscaler blochează tunnel-ul
- Cloudflare Tunnel folosește domenii `.trycloudflare.com` pe HTTPS
- De obicei Zscaler le permite (sunt domenii Cloudflare legitimate)
- Dacă e blocat, încearcă din browser incognito sau verifică cu IT

### Videourile se încarcă greu
- Normal pentru fișiere mari prin tunnel gratuit
- Tunnel-ul Cloudflare are bandwidth limitat pe free tier
- Recomandare: filme la 720p pentru streaming mai fluid

---

## Keyboard Shortcuts

| Tastă | Acțiune |
|-------|---------|
| `Space` | Play / Pause |
| `F` | Fullscreen |
| `←` | Seek -10 secunde |
| `→` | Seek +10 secunde |
| `Shift+←` | Film precedent |
| `Shift+→` | Film următor |
| `↑` | Volume + |
| `↓` | Volume - |
| `M` | Mute / Unmute |
