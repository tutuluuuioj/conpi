import "@/lib/polyfill";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/lib/store";
import { Shell } from "@/components/shell";
import "@near-wallet-selector/modal-ui/styles.css";
import "./globals.css";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Conpi — API credit escrow",
  description: "Buy and sell prepaid LLM API credit. Settlement is escrow on NEAR. Provider keys stay inside an attested enclave.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${sans.variable} ${mono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{window.global=window;window.process=window.process||{env:{NODE_ENV:'production'}};var t=localStorage.getItem("conpi-theme")||"dark";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              function send(data){
                try{
                  fetch('/api/debug-log',{
                    method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body:JSON.stringify(data)
                  }).catch(function(){});
                }catch(e){}
              }
              window.addEventListener('error', function(e){
                send({type:'error', msg:e.message, file:e.filename, line:e.lineno, stack:e.error?e.error.stack:null});
              });
              window.addEventListener('unhandledrejection', function(e){
                send({type:'unhandledrejection', reason:e.reason?String(e.reason):'unknown'});
              });
              var origError = console.error;
              console.error = function(){
                origError.apply(console, arguments);
                var args = Array.prototype.slice.call(arguments).map(function(a){
                  try{ return typeof a === 'object' ? JSON.stringify(a) : String(a); }catch(_){ return String(a); }
                }).join(' ');
                send({type:'console.error', msg:args});
              };
            })();`,
          }}
        />
      </head>
      <body suppressHydrationWarning className="min-h-screen bg-bg font-sans text-sm leading-[22px] text-ink antialiased">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
