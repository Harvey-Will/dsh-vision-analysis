# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately by emailing the maintainer (see the repository owner profile
for contact details) or by opening a GitHub advisory against this repository.
We will acknowledge the report within 7 days and work on a fix.

## Security posture

- **API keys stay masked**: the `debug` report never reveals any part of the
  configured key (not even a prefix). Keys should be stored in
  `UNIVERSAL_VISION_API_KEY` or the masked secret field in settings, not in
  `cordis.yml`.
- **Image bytes stay local-to-endpoint**: local files are read by the tool and
  sent base64-embedded only to the vision endpoint you configured. They never
  enter the session log or the main model.
- **Third-party endpoints are not sandboxed**: the plugin performs no
  sandboxing of the endpoints it calls. Only point it at endpoints you
  control, and only reference `http(s)` image URLs you trust.
- **Plugins run with your permissions**: installing a plugin executes its code
  with your own permissions. Review the source before installing; inclusion in
  the awesome list is not a security audit.
- **Default provider is third-party**: the built-in default uses OVHcloud AI
  Endpoints' free anonymous tier. Review its terms and privacy policy before
  relying on it for sensitive content.
