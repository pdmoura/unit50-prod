// The spinning logo in index.html covers the page from the first paint. Once the
// app knows what to show, it fades away over the screen that has appeared below.
export function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.classList.contains("done")) return;
  splash.classList.add("done");
  const remove = () => splash.remove();
  splash.addEventListener("transitionend", remove, { once: true });
  // In case the fade never runs (a hidden tab, for example).
  setTimeout(remove, 1000);
}
