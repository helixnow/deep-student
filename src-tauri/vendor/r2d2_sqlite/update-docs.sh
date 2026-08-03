#!/bin/sh
cargo clean
cargo doc --no-deps
cd target/doc
git init
git config user.name "Jovansonlee Cesar"
git config user.email "ivanceras@gmail.com"
git add . -A
git commit -m "Committing docs to github pages"
git remote add origin https://github.com/ivanceras/r2d2-sqlite
git checkout -b gh-pages
git push --force origin gh-pages
