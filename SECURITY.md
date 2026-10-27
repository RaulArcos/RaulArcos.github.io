# Security and hosting boundaries

This repository contains a static website and an optional, dependency-free community racing API. It is not an account system or an authoritative multiplayer server.

## Public data and account access

- Names, lap times, ghosts and live positions are community submissions. Validation and rate limits do not prove identity or prevent cheating.
- CORS/origin checks restrict browsers, not scripts that forge headers. Do not treat an allowed Origin as authentication.
- Racing API requests omit browser credentials. The iRacing integration is a static public profile link, not OAuth or access to a user's iRacing account.
- Firebase browser configuration is public client configuration, not an owner account password. Database permissions and API restrictions must still be configured appropriately.
- Never add SSH keys, account tokens, cloud credentials or runtime data to the public repository or static web root.

## Hosting checklist

Before operating a public instance:

1. Keep API data outside the static site and serve the API through HTTPS. Bind to loopback unless an isolated container network requires otherwise.
2. Run the service as a non-root user with a read-only application/root filesystem and a dedicated writable data directory. Do not mount host home directories, credentials or the Docker socket.
3. Separate application networks and expose only the reverse proxy's required public ports. Do not rely on network proximity to authorize access to another service.
4. Drop unnecessary capabilities, prevent privilege escalation, and set CPU/memory/PID and storage limits. Plan proxy/bandwidth abuse protection separately: application limits alone are not DDoS protection.
5. Configure exact allowed origins and trusted proxy addresses. Do not trust arbitrary forwarded headers.
6. Keep the runtime, host, container engine and proxy patched. Preserve verified administrative access and rollback procedures before changing host networking or SSH policy.

See [backend configuration and API behavior](server/README.md). No deployment-specific host configuration or private audit report is required to run the public source.

## Reporting and limitations

Use the website's contact details to coordinate a security report privately. Do not post credentials, private records or exploit details in a public issue.

Automated tests and code review are bounded evidence, not a guarantee against vulnerabilities or compromise. Physical iOS/Android/Safari verification, a comprehensive accessibility audit, cloud-account permissions, historic compromise forensics and capacity certification are separate activities. Publishing source does not apply production hardening or deploy a backend.
