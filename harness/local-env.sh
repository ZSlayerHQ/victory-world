# Sourced by the harness's shell scripts: load_local_env <harness dir> exports this machine's paths from
# harness/local.env (local-env.mjs parses it and says which names it may set). The environment wins over the file.
# Each pair is exported as one word, never eval'd, so a value's $, quotes and backslashes arrive as written.
load_local_env() {
  _local_env_pairs=$(node "$1/local-env.mjs" pairs) || { unset _local_env_pairs; return 0; }
  while IFS= read -r _local_env_kv; do
    [ -n "$_local_env_kv" ] && export "$_local_env_kv"
  done <<EOF
$_local_env_pairs
EOF
  unset _local_env_pairs _local_env_kv
}
