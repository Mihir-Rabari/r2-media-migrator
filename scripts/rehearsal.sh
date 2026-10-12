#!/usr/bin/env bash
# Rehearsal of the reference switch + rollback on an ISOLATED COPY of production data (throwaway MongoDB container on
# 127.0.0.1:27098, restored from the newest backup). Production MongoDB is never touched. R2 is only read when everything is
# already staged (journal copy says every variant is verified, so no uploads are expected).
#
#   bash scripts/rehearsal.sh setup      # start container, restore newest backup, copy journal, write rehearsal config
#   bash scripts/rehearsal.sh migrate    # migrate the copy + verify; database state must change
#   bash scripts/rehearsal.sh rollback   # roll back; database state hash must equal the original
#   bash scripts/rehearsal.sh conflict   # re-migrate, edit one migrated field by hand, roll back: edit must survive (exit 6)
#   bash scripts/rehearsal.sh teardown   # stop and remove the throwaway container
set -uo pipefail
P=/root/media-migrate-private
PORT=27098
CT=v2-rehearsal
CFG=$P/rehearsal.config.json
BK="${BACKUP:-$(ls -1t /var/backups/v2enterprise/*.archive.gz 2>/dev/null | head -1)}"

# shellcheck disable=SC1090
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
source "$P/env.sh"
export REHEARSAL_MONGODB_URI="mongodb://127.0.0.1:$PORT/v2-prod"   # throwaway container, no credentials
cli() { node ~/media-migrator/dist/cli/main.js "$@" --config "$CFG"; }
# canonical state hash of every document of every collection (sorted), computed outside mongosh
dbhash() {
  mongosh --quiet --port $PORT v2-prod --eval 'for (const n of db.getCollectionNames().sort()) db.getCollection(n).find().sort({_id:1}).forEach(d=>print(EJSON.stringify(d)))' | sha256sum | cut -d' ' -f1
}

case "${1:-}" in
setup)
  [ -n "$BK" ] || { echo "no backup archive found"; exit 1; }
  docker rm -f $CT >/dev/null 2>&1
  docker run -d --rm --name $CT -p 127.0.0.1:$PORT:27017 mongo:7 >/dev/null || exit 1
  for _ in $(seq 1 30); do mongosh --quiet --port $PORT --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
  mongorestore --uri="mongodb://127.0.0.1:$PORT" --archive="$BK" --gzip >/dev/null 2>"$P/rehearsal-restore.log" || { echo "restore failed, see $P/rehearsal-restore.log"; exit 1; }
  mkdir -p "$P/rehearsal-journal"; rm -f "$P/rehearsal-journal/journal.sqlite"*
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]+"/journal/journal.sqlite");d.exec("VACUUM INTO \x27"+process.argv[1]+"/rehearsal-journal/journal.sqlite\x27");d.close()' "$P"
  node -e '
const fs=require("fs");const p=process.argv[1];
const t=fs.readFileSync(p+"/v2.config.json","utf8").split(p+"/journal").join(p+"/rehearsal-journal");
const c=JSON.parse(t);c.environment="staging";c.database.uriEnv="REHEARSAL_MONGODB_URI";c.safety.allowProductionMutations=false;
fs.writeFileSync(p+"/rehearsal.config.json",JSON.stringify(c,null,2),{mode:0o600});' "$P"
  H0=$(dbhash); echo "$H0" > "$P/rehearsal-H0.txt"
  echo "restored $(basename "$BK") into throwaway container; original state hash H0=$H0"
  cli config validate | head -3
  ;;
migrate)
  H0=$(cat "$P/rehearsal-H0.txt")
  cli migrate --yes; echo "migrate exit=$?"
  H1=$(dbhash); echo "state hash after migrate H1=$H1  ($( [ "$H1" != "$H0" ] && echo CHANGED-as-expected || echo UNCHANGED-unexpected ))"
  cli verify; echo "verify exit=$?"
  ;;
rollback)
  H0=$(cat "$P/rehearsal-H0.txt")
  cli rollback --yes; echo "rollback exit=$?"
  H2=$(dbhash); echo "state hash after rollback H2=$H2"
  [ "$H2" = "$H0" ] && echo "EXACT RESTORE: database is byte-identical to the original (H2 == H0)" || echo "MISMATCH: H2 != H0"
  ;;
conflict)
  cli migrate --yes; echo "re-migrate exit=$?"
  ID=$(mongosh --quiet --port $PORT v2-prod --eval 'const d=db.products.findOne({photo:/media\/v1/});print(d?d._id.toString():"")')
  [ -n "$ID" ] || { echo "no migrated product found"; exit 1; }
  mongosh --quiet --port $PORT v2-prod --eval "db.products.updateOne({_id:ObjectId('$ID')},{\$set:{photo:'https://example.com/hand-edited.jpg'}})" >/dev/null
  cli rollback --yes; echo "rollback exit=$? (6 expected: one conflict)"
  AFTER=$(mongosh --quiet --port $PORT v2-prod --eval "print(db.products.findOne({_id:ObjectId('$ID')}).photo)")
  echo "hand-edited field after rollback: $AFTER"
  [ "$AFTER" = "https://example.com/hand-edited.jpg" ] && echo "PASS: the concurrent edit was NOT overwritten" || echo "FAIL: edit was overwritten"
  ;;
teardown)
  docker rm -f $CT >/dev/null 2>&1; echo "throwaway container removed"
  ;;
*) echo "usage: bash scripts/rehearsal.sh setup|migrate|rollback|conflict|teardown"; exit 2 ;;
esac
