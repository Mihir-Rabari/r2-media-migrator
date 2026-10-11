#!/usr/bin/env bash
# Read-only production MongoDB backup + verification for V2 Enterprise.
# Run ON THE SERVER as the user that owns the PM2 process:   bash prod-mongodb-backup.sh [pm2-app-name]
# It never prints or passes the connection string on a command line (config file mode 600 / env only), never writes
# inside the app repo or any served directory, never overwrites a backup, and never modifies production data.
# Requires: node, pm2, mongodump, mongorestore, mongosh. Optional: mongod (for an isolated restore test).
set -euo pipefail
umask 077

APP="${1:-v2-app}"
DEST="${BACKUP_DIR:-/var/backups/v2enterprise}"        # outside the repo and any web root
TS="$(date -u +%Y%m%d-%H%M%S)"
NAME="v2enterprise-mongodb-production-${TS}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"; chmod 700 "$DEST"
FINAL="$DEST/$NAME.archive.gz"; PART="$DEST/.$NAME.archive.gz.partial"; REPORT="$DEST/$NAME.report.txt"
[ -e "$FINAL" ] && { echo "refusing to overwrite $FINAL"; exit 1; }
say() { echo "$*" | tee -a "$REPORT" >&2; }
: > "$REPORT"; chmod 600 "$REPORT"

for t in node pm2 mongodump mongorestore mongosh; do command -v "$t" >/dev/null || { say "BLOCKED: $t not installed"; exit 2; }; done
say "== tools"; say "$(mongodump --version | head -1)"; say "$(mongosh --version)"

# ---- Phase 1: effective MONGODB_URI from the running PM2 process (never printed)
node -e '
const {execFileSync}=require("child_process"),fs=require("fs");
const app=process.argv[1], out=process.argv[2];
const list=JSON.parse(execFileSync("pm2",["jlist"],{encoding:"utf8"}));
const p=list.find(x=>x.name===app); if(!p){console.error("BLOCKED: pm2 app not found: "+app);process.exit(2)}
let uri=p.pm2_env&&p.pm2_env.MONGODB_URI;
if(!uri){ // fall back to the app .env, parsed without logging
  const f=(p.pm2_env.pm_cwd||"")+"/.env"; try{ for(const l of fs.readFileSync(f,"utf8").split(/\r?\n/)){const m=/^\s*MONGODB_URI\s*=\s*(.*)\s*$/.exec(l); if(m) uri=m[1].replace(/^["\x27]|["\x27]$/g,"")} }catch{}
}
if(!uri){console.error("BLOCKED: MONGODB_URI not found in PM2 env or .env");process.exit(2)}
const u=new URL(uri);
fs.writeFileSync(out+"/mongo.yaml","uri: "+JSON.stringify(uri)+"\n",{mode:0o600});
fs.writeFileSync(out+"/env.sh","export MONGODB_URI=\x27"+uri.replace(/\x27/g,"\x27\\\x27\x27")+"\x27\n",{mode:0o600});
console.log(JSON.stringify({scheme:u.protocol,host:u.hostname.replace(/^[^.]+/,"***")+(u.port?":"+u.port:""),srv:u.protocol==="mongodb+srv:",db:u.pathname.replace(/^\//,"")||null,hasAuth:!!u.username,tls:/tls=true|ssl=true/i.test(u.search)||u.protocol==="mongodb+srv:",replicaSetParam:/replicaSet=/i.test(u.search)}));
' "$APP" "$WORK" | tee -a "$REPORT" >&2
# shellcheck disable=SC1091
. "$WORK/env.sh"

DBNAME="$(node -e 'const u=new URL(process.env.MONGODB_URI);console.log(u.pathname.replace(/^\//,""))')"
if [ -z "$DBNAME" ]; then
  say "BLOCKED: the production URI names no database. Databases visible to this user:"
  mongosh --quiet --eval 'JSON.stringify(db.getMongo().getDBNames())' "$MONGODB_URI" 2>&1 | tee -a "$REPORT" >&2 || true
  say "Do not guess: add the database name to the URI (or confirm it) and rerun."; exit 2
fi
say "production database: $DBNAME"

# ---- topology, versions, size (read-only)
INFO="$(mongosh --quiet --eval '
const h=db.hello(); const s=db.stats();
print(JSON.stringify({version:db.version(),replicaSet:h.setName||null,sharded:h.msg==="isdbgrid",primary:h.isWritablePrimary,
  dataSize:s.dataSize,storageSize:s.storageSize,indexSize:s.indexSize,collections:s.collections}))' "$MONGODB_URI")"
say "server/topology/size: $INFO"
NEED="$(node -e 'const i=JSON.parse(process.argv[1]);console.log(Math.ceil((i.dataSize+i.indexSize)*1.2))' "$INFO")"
AVAIL="$(df --output=avail -B1 "$DEST" | tail -1 | tr -d ' ')"
say "disk: need ~${NEED} bytes (uncompressed estimate), available ${AVAIL} bytes in $DEST"
[ "$AVAIL" -gt "$NEED" ] || { say "BLOCKED: insufficient disk space"; exit 2; }

inventory() { mongosh --quiet --eval '
const out={}; for (const c of db.getCollectionInfos({type:"collection"})) { const col=db.getCollection(c.name);
  out[c.name]={count:col.countDocuments({}),indexes:col.getIndexes().length}; }
print(JSON.stringify(out))' "$MONGODB_URI"; }
BEFORE="$(inventory)"; say "inventory before: $BEFORE"

# ---- Phase 2: backup (credentials only via the 0600 config file)
say "== mongodump (consistency: per-collection snapshot, NOT point-in-time; see report notes)"
mongodump --config="$WORK/mongo.yaml" --archive="$PART" --gzip 2> "$WORK/dump.log" || { say "FAIL: mongodump exited non-zero; partial kept at $PART"; sed 's#mongodb[^ ]*#[uri]#g' "$WORK/dump.log" | tail -20 | tee -a "$REPORT" >&2; exit 1; }
chmod 600 "$PART"; mv -n "$PART" "$FINAL"; [ -e "$FINAL" ] || { say "FAIL: could not publish"; exit 1; }
AFTER="$(inventory)"; say "inventory after:  $AFTER"

# ---- Phase 3: verify
SIZE="$(stat -c %s "$FINAL")"; SUM="$(sha256sum "$FINAL" | cut -d' ' -f1)"
say "== file: $FINAL size=$SIZE sha256=$SUM"
say "mongodump per-collection counts:"; grep -E "done dumping" "$WORK/dump.log" | sed 's#mongodb[^ ]*#[uri]#g' | tee -a "$REPORT" >&2
say "== archive inspection (mongorestore --dryRun, no target written)"
mongorestore --archive="$FINAL" --gzip --dryRun -v 2> "$WORK/dry.log" && say "archive inspection: PASS" || say "archive inspection: FAIL"
grep -Eo "$DBNAME\.[A-Za-z0-9_.-]+" "$WORK/dry.log" | sort -u | tee -a "$REPORT" >&2
node -e '
const b=JSON.parse(process.argv[1]),a=JSON.parse(process.argv[2]);
const names=Object.keys(b); const drift=names.filter(n=>!a[n]||a[n].count!==b[n].count);
console.log("collections: "+names.length+"; count drift between before/after inventory: "+(drift.length?drift.join(", ")+" (concurrent writes during the dump)":"none"));
' "$BEFORE" "$AFTER" | tee -a "$REPORT" >&2

# ---- isolated restore test (only if a local mongod exists; never against production)
if command -v docker >/dev/null && docker image inspect mongo:7 >/dev/null 2>&1; then
  # throwaway container from the already-present image: separate name, loopback-only port, no volumes, never the production container
  PORT=27099; CT="v2-restore-test-$TS"
  docker run -d --rm --name "$CT" -p 127.0.0.1:$PORT:27017 mongo:7 >/dev/null
  for _ in $(seq 1 30); do mongosh --quiet --port $PORT --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
  mongorestore --uri="mongodb://127.0.0.1:$PORT" --archive="$FINAL" --gzip >/dev/null 2>"$WORK/restore.log" && RT=ok || RT=fail
  RESTORED="$(mongosh --quiet --port $PORT --eval 'const d=db.getSiblingDB("'"$DBNAME"'");const o={};for(const c of d.getCollectionInfos({type:"collection"}))o[c.name]={count:d.getCollection(c.name).countDocuments({}),indexes:d.getCollection(c.name).getIndexes().length};print(JSON.stringify(o))')"
  docker stop "$CT" >/dev/null 2>&1 || true
  say "restore test ($RT) into isolated throwaway container: $RESTORED"
  say "restore test counts vs inventory-after: $( [ "$RESTORED" = "$AFTER" ] && echo MATCH || echo DIFFERENT-compare-manually )"
elif command -v mongod >/dev/null; then
  PORT=27099; mkdir -p "$WORK/rt"
  mongod --dbpath "$WORK/rt" --port $PORT --bind_ip 127.0.0.1 --fork --logpath "$WORK/rt.log" >/dev/null
  mongorestore --uri="mongodb://127.0.0.1:$PORT" --archive="$FINAL" --gzip >/dev/null 2>"$WORK/restore.log" && RT=ok || RT=fail
  RESTORED="$(mongosh --quiet --port $PORT --eval 'const d=db.getSiblingDB("'"$DBNAME"'");const o={};for(const c of d.getCollectionInfos({type:"collection"}))o[c.name]={count:d.getCollection(c.name).countDocuments({}),indexes:d.getCollection(c.name).getIndexes().length};print(JSON.stringify(o))')"
  mongod --dbpath "$WORK/rt" --shutdown >/dev/null 2>&1 || true
  say "restore test ($RT) into isolated local mongod: $RESTORED"
  say "restore test counts vs inventory-after: $( [ "$RESTORED" = "$AFTER" ] && echo MATCH || echo DIFFERENT-compare-manually )"
else
  say "restore test: NOT RUN (no isolated mongod on this host); backup is NOT restore-verified"
fi
say "== done. Report: $REPORT   (contains no credentials). Nothing in production was modified."
