// 展示のページで共通の道具
window.Exhibit = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } };
  async function load() { const r = await fetch('data.json', { cache: 'no-store' }); return r.json(); }
  const participant = () => get('participant');
  const setParticipant = (v) => set('participant', v);
  // 28日は全員が6枚すべてをガイドと音ありで聴く（体験後のアンケートで6枚すべての音量・声と音・響きを聞くため）
  function condition() { return 'all'; }
  return { esc, load, participant, setParticipant, condition };
})();
