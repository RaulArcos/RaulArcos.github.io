// Racing Lab HTTPS backend deployed on the owner's VPS.
// Set window.RACING_API_URL before this script to override it; '' explicitly selects device/tab-only play.
window.RACING_API_URL = typeof window.RACING_API_URL === 'string'
  ? window.RACING_API_URL
  : 'https://api.ircopilot.com/racing';
