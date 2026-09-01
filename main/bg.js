"use strict";
console.log('log on');
chrome.webRequest.onBeforeSendHeaders.addListener(...handleRequestHeaders());
chrome.webRequest.onHeadersReceived.addListener(...handleResponseHeaders());
/* 215
20220412 */