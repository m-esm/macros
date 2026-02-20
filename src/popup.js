const toggle = document.getElementById('enabled');
const status = document.getElementById('status');

chrome.storage.local.get('hwEnabled', ({ hwEnabled }) => {
  toggle.checked = hwEnabled !== false;
  updateStatus();
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ hwEnabled: toggle.checked });
  updateStatus();
});

function updateStatus() {
  status.textContent = toggle.checked
    ? 'Active on Wolt venue pages.'
    : 'Disabled.';
}
