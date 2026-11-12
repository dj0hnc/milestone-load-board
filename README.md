# 🦺 Safe Dumping Training — Project Roadrunner

Standalone driver-certification app for the Safe Dumping program (Milestone Supply).
Zero dependencies: plain Node (node:http + node:sqlite). Nothing shared with any
other Milestone system.

## Run

```
node server.js        # http://localhost:8792
```

or `run-safety.cmd` (keeps it alive and self-updates from the `safety-roadrunner`
branch every minute).

## Pages

| Path        | What                                                        |
|-------------|-------------------------------------------------------------|
| `/`         | Driver training (public, bilingual ES/EN)                   |
| `/?code=RR-XXXXXX` | Public certificate verification (QR target) + field mode |
| `/admin`    | Admin panel (admin-code login)                              |

## Data & keys

Everything lives in `data/` (ignored by git — this repo is public):
SQLite DB, training videos (`video_en.mp4` / `video_es.mp4`), the program PDFs,
the program seal images, and `config.json` with the generated `adminCode` and
`uploadKey`. On the office box the keys are also copied to
`OneDrive\mab-deploy\safety-keys.json`.

Machine uploads (videos, PDFs, seals):
`PUT /api/safety/doc-upload?key=<uploadKey>&name=sop|infosheet|plan|seal|bird|video_en|video_es`
