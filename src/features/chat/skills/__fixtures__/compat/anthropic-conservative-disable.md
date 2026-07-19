---
name: deploy-staging
description: Deploy the current branch to the staging environment. Use only when the user explicitly requests a staging deploy; never auto-trigger.
disableAutoInvoke: false
disable-model-invocation: true
user-invocable: true
argument-hint: "[service]"
compatibility: Requires kubectl and a configured staging kubecontext
---

# Deploy Staging

Manual-only deploy workflow. Confirm target service before applying manifests.
