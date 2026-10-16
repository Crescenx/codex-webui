let host: HTMLElement | undefined;
export function setViewerRoot(root?: HTMLElement) { host=root; }
export function viewerDocument(): Document { return host?.ownerDocument || document; }
export function viewerWindow(): Window & typeof globalThis { return (viewerDocument().defaultView || window) as Window & typeof globalThis; }
export function viewerRoot(): HTMLElement { return host || viewerDocument().body; }

// Adopted nodes retain the constructors of their creation window.
export function isElement(value:unknown):value is Element {return !!value && typeof value==='object' && (value as Node).nodeType===1;}
export function isHTMLElement(value:unknown):value is HTMLElement {return isElement(value) && value.namespaceURI==='http://www.w3.org/1999/xhtml';}

let openMaterial: ((target:string)=>Promise<unknown>) | undefined;
let vaultName: string | undefined;
let vaultRoot: string | undefined;
let imageSource: ((target:string)=>string) | undefined;
export function setMaterialHost(opener?: (target:string)=>Promise<unknown>, image?: (target:string)=>string, vault?:string, root?:string) {openMaterial=opener;imageSource=image;vaultName=vault;vaultRoot=root;}
export function materialOpener(){return openMaterial;}
export function materialImage(target:string){return imageSource?.(target);}

export function materialVault(){return vaultName;}
export function materialVaultRoot(){return vaultRoot;}
