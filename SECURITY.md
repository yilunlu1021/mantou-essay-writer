# Security and privacy

The tool reads explicit local input files and writes new local session folders. It has no network client, credential store, telemetry or model API integration. An agent using the tool has its own privacy and model settings.

Sessions contain full source text, the original file, prompt, patches and reports. Keep them outside this repository and protect them as you would the original essay. Local files use owner-only mode where supported. On Windows, permissions also depend on the containing folder's ACL. Back up whole sessions when you need their history.

Import and patch sizes are bounded. DOCX parsing rejects unsupported structures, external relationships, DTD/entity definitions, ambiguous archives and excessive expansion. It processes only a documented subset. It creates a new Word layout and cannot certify that a separate manual text conversion captured everything.

Version hashes detect changes within the recorded local history. They are not signatures and cannot prove authorship or human approval against someone able to rewrite the whole session. Machine output always keeps delivery unauthorized. Review the full prompt, facts, author voice and candidate before external use.

Do not include real essays, personal data, session folders, credentials or private infrastructure details in issues. For a vulnerability, use the repository owner's private GitHub contact where available. Describe the affected version and provide a small synthetic reproducer. Do not publish sensitive document contents.
