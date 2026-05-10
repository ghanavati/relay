#!/usr/bin/env bash
# scripts/smoke-test.sh
#
# DEPRECATED: superseded by `relay verify` (T16).
#
# This wrapper exists only for backwards compatibility with anyone who still
# invokes `./scripts/smoke-test.sh` from muscle memory, CI, or old docs. It
# prints a deprecation warning to stderr and forwards all arguments to
# `relay verify`. New callers should run `relay verify` directly.

printf 'warning: scripts/smoke-test.sh is deprecated; use `relay verify` instead.\n' >&2
exec relay verify "$@"
