declare var chrome: any;

chrome.devtools.panels.create(
  "CaptureAPI",
  "", // Icon path
  "panel.html",
  (panel: any) => {
    console.log("Panel created");
  }
);