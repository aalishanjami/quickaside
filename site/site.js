'use strict';

// The only script on the site: the Copy buttons. The page works without it.
for (const button of document.querySelectorAll('.copy')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(code);
      button.textContent = 'Press Cmd+C';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1800);
  });
}
