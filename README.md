# Local Build Runner

Reusable VSCode extension for running local Dart/Flutter deployment scripts with dropdowns, buttons, logs, and step status.

## Install for local development

Open this folder in VSCode and press `F5` to launch an Extension Development Host.

## Workspace config

Create `.vscode/local-build.json` in each project.

FastChop example:

```json
{
  "name": "FastChop",
  "script": "tools/deploy/bin/local_build.dart",
  "runner": "fvm dart run",
  "defaults": {
    "mode": "build",
    "env": "dev",
    "platform": "all",
    "apps": "all",
    "playTrack": "internal",
    "firebaseGroupAliases": "internal-testers"
  },
  "options": {
    "mode": ["build", "patch"],
    "env": ["dev", "prod"],
    "platform": ["all", "android", "ios"],
    "apps": ["all", "customer", "user", "vendor", "delivery"]
  },
  "valueFlags": [
    "build-name",
    "build-number",
    "release-version",
    "flutter-version",
    "google-service-account",
    "firebase-service-account",
    "asc-key-id",
    "asc-issuer-id",
    "asc-private-key-path",
    "prod-config-source",
    "dev-config-source",
    "play-track",
    "firebase-group-aliases"
  ],
  "booleanFlags": [
    "no-upload",
    "dry-run",
    "allow-store-fallback",
    "can-clean",
    "skip-pub-get",
    "skip-build-runner",
    "skip-pod-install",
    "no-obfuscate"
  ],
  "credentials": {
    "google-service-account": "tools/deploy/credential/service_account.json",
    "firebase-service-account": "tools/deploy/credential/firebase_service_account.json",
    "apple-config": "tools/deploy/credential/apple_config.json"
  },
  "steps": [
    { "name": "Pub get", "match": "pub get" },
    { "name": "Build runner", "match": "build_runner" },
    { "name": "Pods", "match": "pod install" },
    { "name": "Android", "match": "android" },
    { "name": "iOS", "match": "ios" },
    { "name": "Upload", "match": "upload" }
  ]
}
```

NexBox example:

```json
{
  "name": "NexBox",
  "script": "tools/deploy/bin/local_build.dart",
  "runner": "fvm dart run",
  "defaults": {
    "mode": "build",
    "env": "dev",
    "platform": "all"
  },
  "options": {
    "mode": ["build", "patch"],
    "env": ["dev", "stg", "prod"],
    "platform": ["all", "android", "ios"]
  },
  "valueFlags": [
    "build-name",
    "build-number",
    "release-version",
    "flutter-version",
    "android-package-name"
  ],
  "booleanFlags": [
    "no-upload",
    "dry-run",
    "can-clean",
    "skip-pub-get",
    "skip-build-runner",
    "skip-pod-install",
    "no-obfuscate"
  ]
}
```

## Commands

- `Local Build Runner: Run...`
- `Local Build Runner: Build`
- `Local Build Runner: Patch`
- `Local Build Runner: Dry Run`
- `Local Build Runner: Cancel Running Build`
- `Local Build Runner: Open Config`

The extension runs the configured script from the workspace root, streams output to a status webview and output channel, and lets you cancel a running process.


```
code --extensionDevelopmentPath="$(pwd)"
```
