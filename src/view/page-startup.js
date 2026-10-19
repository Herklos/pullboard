/**
 * The hosted page's startup helpers. src/cockpit.js embeds each one's source text in the page, so each may use only
 * its arguments and browser globals.
 */

/** Whether a value is a local session this page may use: version 1, a loopback origin with its port, and a secret. */
export function validLocalSession(value) {
  if (!value || value.version !== 1 || typeof value.key !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value.key) || typeof value.origin !== 'string') return false;
  try {
    const address = new URL(value.origin);
    return address.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(address.hostname) && address.port !== '' && address.origin === value.origin;
  } catch { return false; }
}

/**
 * What the page's startup needs to know about this device, and its two safeguards (#900). A phone never runs
 * Pullboard, so it never looks for this computer's view, and its relay shell is its only screen, so a startup failure
 * is said there. No startup wait goes without a deadline.
 *
 * @param {HTMLElement} root - The document's root element, which the relay's page marks as a phone before first paint.
 */
export function pageStartup(root) {
  const phone = root.dataset.relayDevice === 'phone';
  return {
    phone,
    /** Put text in the phone shell's status line and keep the shell showing; false on a computer or without a shell. */
    say(text) {
      const status = phone ? root.querySelector('#relay-screen .relay-live span') : null;
      if (!status) return false;
      root.dataset.relayScreen ||= 'share';
      status.textContent = text;
      return true;
    },
    /** Await load(), failing with message after ms; the timer is cleared either way, so it never outlives the load. */
    within(load, ms, message) {
      let timer;
      const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
      return Promise.race([load(), late]).finally(() => clearTimeout(timer));
    },
  };
}
