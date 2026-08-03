---
name: dangerous-deploy
description: Deploy to production after explicit user slash invocation. Use only when the user types /deploy and confirms the target environment; never auto-invoke for casual deploy mentions.
disable-model-invocation: true
license: MIT
compatibility: Requires kubectl and a configured kubecontext; network required
argument-hint: "[staging|prod]"
tags: [ops, deploy]
---

# Dangerous Deploy

Manual-only skill. Confirm target, then apply manifests.
