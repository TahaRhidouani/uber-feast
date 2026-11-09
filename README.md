# Uber Feast

### Main features:

- Features a responsive UI
- Almost all actions are transitioned with a smooth animation
- Uses a MongoDB to store user data
- Dynamically loads restaurant information from the backend

<br />

**A georgeous UI featuring smooth animations** ![order](./images/screenshot_1.gif)

**A beautiful Uber Eats reskin** ![home](./images/screenshot_2.png)

**A login system to keep track of your order** ![login](./images/screenshot_3.png)

## Run

Every push to `main` builds the image `ghcr.io/taharhidouani/uber-feast` (tags `main` and `sha-<commit>`). The container listens on port 8080 and answers `GET /healthz`; the app starts at `/home`.

| Variable | Purpose |
| --- | --- |
| `MONGO_URL` | MongoDB connection string; data and sessions go to the database `a4` |
| `SESSION_SECRET` | Random string that signs session cookies; without it sessions reset on every restart |
| `PORT` | Listen port, default 8080 |

```sh
docker run -p 8080:8080 -e MONGO_URL=mongodb://user:pass@mongo:27017/a4?authSource=a4 -e SESSION_SECRET=change-me ghcr.io/taharhidouani/uber-feast:main
```

To reset the database to the 10 demo users (this drops every collection in `a4`, sessions included):

```sh
docker run --rm -e MONGO_URL=mongodb://user:pass@mongo:27017/a4?authSource=a4 ghcr.io/taharhidouani/uber-feast:main node database-initializer.js
```

Locally: `npm install`, then `npm start` and `MONGO_URL=... node database-initializer.js`.
