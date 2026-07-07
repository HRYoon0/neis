// 툴바 아이콘을 누르면 현재 탭에서 사이드패널을 연다.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn("sidePanel setPanelBehavior 실패:", e);
  }
});

// 일부 크롬 버전 호환: 액션 클릭 시 명시적으로 사이드패널 열기
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // openPanelOnActionClick 로 이미 열렸으면 무시
  }
});
