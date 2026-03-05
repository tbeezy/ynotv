// Declare markdown file imports with ?raw suffix
declare module '*.md?raw' {
    const content: string;
    export default content;
}

declare module '@root/*.md?raw' {
    const content: string;
    export default content;
}
