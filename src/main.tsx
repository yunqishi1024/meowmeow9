import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 请求持久化存储，防止浏览器自动清理 localStorage
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then((granted) => {
    console.log(granted
      ? "Storage persisted — data won't be auto-cleared."
      : "Storage persistence denied — data may be cleared by browser.");
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
