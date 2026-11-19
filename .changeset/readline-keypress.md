---
"@vivari/core": patch
---

`readline.createInterface()` on a terminal decodes its input into `keypress` events, as Node's does. Prompt libraries listen for them without asking: clack's confirm and select prompts (Nuxt's CLI, create-* scaffolders) sat on their question whatever was typed, so `nuxt module remove @nuxt/ui` never got past "Do you also want to remove them?".
