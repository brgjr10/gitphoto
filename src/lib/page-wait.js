/**
 * Resolves once every <img> in the page has finished loading or failed.
 *
 * Both the app capture and the banner composition need this, and both were
 * duplicating it, which is how they drifted apart. Images that resolve late
 * would otherwise be screenshotted mid-decode and appear as blank boxes.
 */
export const waitForImages = (page) =>
  page
    .evaluate(() =>
      Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise((settle) => {
                img.addEventListener('load', settle, { once: true });
                img.addEventListener('error', settle, { once: true });
              }),
          ),
      ),
    )
    .catch(() => {
      // A page that never finishes decoding must not fail the whole render; the
      // layout audit and the blank-capture check are what catch the real damage.
    });
