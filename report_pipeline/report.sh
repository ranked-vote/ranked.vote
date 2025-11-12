#!/bin/sh

set -o pipefail

# Run report generation with timestamping
cargo run --release -- report election-metadata raw-data preprocessed reports "$@" 2>&1 | ts '[%H:%M:%.S]'
