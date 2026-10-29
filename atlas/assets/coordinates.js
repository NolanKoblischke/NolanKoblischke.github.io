(() => {
  const resetTimers = new WeakMap();

  async function writeCoordinates(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Older browsers and restricted clipboard permissions can use selection copying.
      }
    }

    const previousFocus = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text;
    input.readOnly = true;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.append(input);
    let copied;
    try {
      input.select();
      copied = document.execCommand('copy');
    } finally {
      input.remove();
      previousFocus?.focus({ preventScroll: true });
    }
    if (!copied) throw new Error('Clipboard unavailable');
  }

  document.querySelectorAll('.plate .coords').forEach((coordinates) => {
    const { ra, dec } = coordinates.dataset;
    const imageName = coordinates.closest('.plate').querySelector('.plate-number').textContent.trim();
    const group = document.createElement('div');
    group.className = 'coordinate-copy';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Copy coordinates for ${imageName}`);

    const status = document.createElement('span');
    status.className = 'copy-status';
    status.setAttribute('role', 'status');

    const formats = [
      { label: 'Copy RA, Dec', value: `${ra} ${dec}`, purpose: 'space-separated decimal degrees' },
      { label: 'NED', value: `${ra}d ${dec}d`, purpose: 'NED decimal degrees with explicit degree units' },
    ];

    formats.forEach(({ label, value, purpose }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = `Copy ${purpose}: ${value}`;
      button.setAttribute('aria-label', `Copy ${purpose} for ${imageName}`);
      button.addEventListener('click', async () => {
        try {
          await writeCoordinates(value);
        } catch {
          window.prompt('Copy RA and Dec:', value);
          return;
        }
        clearTimeout(resetTimers.get(button));
        button.textContent = 'Copied!';
        status.textContent = `Coordinates copied: ${value}`;
        resetTimers.set(button, setTimeout(() => {
          button.textContent = label;
          status.textContent = '';
        }, 1800));
      });
      group.append(button);
    });

    group.append(status);
    coordinates.after(group);
  });
})();
