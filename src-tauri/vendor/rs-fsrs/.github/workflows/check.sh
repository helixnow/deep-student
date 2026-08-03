#!/bin/bash

set -eux -o pipefail

cargo fmt --check || (
	printf "
Please run 'cargo fmt' to format the code.
"
	exit 1
)

cargo clippy -- -D clippy::nursery || (
	printf "
run 'cargo clippy -- -D clippy::nursery' to check the code.
"
	exit 1
)

cargo install cargo-llvm-cov --locked
SKIP_TRAINING=1 cargo llvm-cov --release
