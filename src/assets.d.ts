// Декларации для Bun `import ... with { type: "file" }`
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
