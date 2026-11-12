// Owner rule 2026-11-12: an app must release everything on quit and never panic
// when a second copy or a busy port meets it. These are the plain sentences both
// paths use, kept pure so a test can pin them.
function secondInstanceMessage() {
  return 'Business Studio KH is already running. Switched to the open window instead of starting a second copy.';
}

function portBusyMessage(port) {
  return `Port ${port} is already in use, so this Mac is not serving other Macs right now. Choose a different port in Settings → Multi-Mac, or quit the other copy of Business Studio KH.`;
}

module.exports = { secondInstanceMessage, portBusyMessage };
