declare var chrome: any;

chrome.devtools.panels.create(
  "CaptureApi",
  "", // Icon path
  "panel.html",
  (panel: any) => {
    console.log("Panel created");
  }
);