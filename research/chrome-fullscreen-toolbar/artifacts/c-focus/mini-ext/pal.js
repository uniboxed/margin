watchFocus('pal');
document.getElementById('q').focus();
LOG('pal', 'q.focus() called');
setTimeout(() => LOG('pal', 'q +500ms'), 500);
