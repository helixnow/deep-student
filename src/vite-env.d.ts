/// <reference types="vite/client" />

// JSON module types
declare module "*.json" {
  const value: any;
  export default value;
}

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const url: string;
  export default url;
}
