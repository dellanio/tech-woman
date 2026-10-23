# Sourced by fakes: append one JSON line per call to $TW_FAKE_LOG.
tw_json() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}
tw_log() {
  local cmd=$1 tripwire=$2; shift 2
  local args="" a
  for a in "$@"; do args+="${args:+,}$(tw_json "$a")"; done
  printf '{"cmd":%s,"args":[%s],"tripwire":%s}\n' "$(tw_json "$cmd")" "$args" "$tripwire" >> "$TW_FAKE_LOG"
}
tw_real() {
  local name=$1; shift
  PATH=${PATH#*:} command "$name" "$@"
}
