"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const atom_1 = require("atom");
const electron_1 = require("electron");
const fileUriToPath = require("file-uri-to-path");
const util_1 = require("../util");
const util_2 = require("./util");
class WebviewHandler {
    constructor(init) {
        this.emitter = new atom_1.Emitter();
        this.disposables = new atom_1.CompositeDisposable();
        this.destroyed = false;
        this.zoomLevel = 0;
        this.replyCallbacks = new Map();
        this.replyCallbackId = 0;
        this._element = document.createElement('webview');
        this._element.classList.add('markdown-preview-plus', 'native-key-bindings');
        this._element.disablewebsecurity = 'true';
        this._element.nodeintegration = 'true';
        this._element.src = `file:///${__dirname}/../../client/template.html`;
        this._element.style.width = '100%';
        this._element.style.height = '100%';
        this._element.addEventListener('ipc-message', (e) => {
            switch (e.channel) {
                case 'zoom-in':
                    this.zoomIn();
                    break;
                case 'zoom-out':
                    this.zoomOut();
                    break;
                case 'did-scroll-preview':
                    this.emitter.emit('did-scroll-preview', e.args[0]);
                    break;
                case 'uncaught-error': {
                    const err = e.args[0];
                    const newErr = new Error();
                    atom.notifications.addFatalError(`Uncaught error ${err.name} in markdown-preview-plus webview client`, {
                        dismissable: true,
                        stack: newErr.stack,
                        detail: `${err.message}\n\nstack:\n${err.stack}`,
                    });
                    break;
                }
                case 'request-reply': {
                    const { id, request, result } = e.args[0];
                    const cb = this.replyCallbacks.get(id);
                    if (cb && request === cb.request) {
                        const callback = cb.callback;
                        callback(result);
                    }
                    break;
                }
            }
        });
        this._element.addEventListener('will-navigate', async (e) => {
            const exts = util_1.atomConfig().previewConfig.shellOpenFileExtensions;
            const forceOpenExternal = exts.some((ext) => e.url.toLowerCase().endsWith(`.${ext.toLowerCase()}`));
            if (e.url.startsWith('file://') && !forceOpenExternal) {
                util_1.handlePromise(atom.workspace.open(fileUriToPath(e.url)));
            }
            else {
                electron_1.shell.openExternal(e.url);
            }
        });
        this.disposables.add(atom.styles.onDidAddStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidRemoveStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidUpdateStyleElement(() => {
            this.updateStyles();
        }));
        const onload = () => {
            if (this.destroyed)
                return;
            this._element.setZoomLevel(this.zoomLevel);
            this.updateStyles();
            init();
        };
        this._element.addEventListener('dom-ready', onload);
    }
    get element() {
        return this._element;
    }
    async runJS(js) {
        return new Promise((resolve) => this._element.executeJavaScript(js, false, resolve));
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.disposables.dispose();
        this._element.remove();
    }
    async update(html, renderLaTeX) {
        if (this.destroyed)
            return undefined;
        return this.runRequest('update-preview', {
            html,
            renderLaTeX,
        });
    }
    setSourceMap(map) {
        this._element.send('set-source-map', { map });
    }
    setBasePath(path) {
        this._element.send('set-base-path', { path });
    }
    init(atomHome, mathJaxConfig, mathJaxRenderer = util_1.atomConfig().mathConfig.latexRenderer) {
        this._element.send('init', {
            atomHome,
            mathJaxConfig,
            mathJaxRenderer,
        });
    }
    updateImages(oldSource, version) {
        this._element.send('update-images', {
            oldsrc: oldSource,
            v: version,
        });
    }
    async saveToPDF(filePath) {
        const opts = util_1.atomConfig().saveConfig.saveToPDFOptions;
        const customPageSize = parsePageSize(opts.customPageSize);
        const pageSize = opts.pageSize === 'Custom' ? customPageSize : opts.pageSize;
        if (pageSize === undefined) {
            throw new Error(`Failed to parse custom page size: ${opts.customPageSize}`);
        }
        const selection = await this.getSelection();
        const printSelectionOnly = selection ? opts.printSelectionOnly : false;
        const newOpts = Object.assign({}, opts, { pageSize,
            printSelectionOnly });
        await this.prepareSaveToPDF(newOpts);
        try {
            const data = await new Promise((resolve, reject) => {
                this._element.printToPDF(newOpts, (error, data) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(data);
                });
            });
            await new Promise((resolve, reject) => {
                fs.writeFile(filePath, data, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        finally {
            util_1.handlePromise(this.finishSaveToPDF());
        }
    }
    sync(line, flash) {
        this._element.send('sync', { line, flash });
    }
    async syncSource() {
        return this.runRequest('sync-source', {});
    }
    scrollSync(firstLine, lastLine) {
        this._element.send('scroll-sync', { firstLine, lastLine });
    }
    zoomIn() {
        this.zoomLevel += 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    zoomOut() {
        this.zoomLevel -= 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    resetZoom() {
        this.zoomLevel = 0;
        this._element.setZoomLevel(this.zoomLevel);
    }
    print() {
        this._element.print();
    }
    openDevTools() {
        this._element.openDevTools();
    }
    async reload() {
        await this.runRequest('reload', {});
        this._element.reload();
    }
    error(msg) {
        this._element.send('error', { msg });
    }
    async getTeXConfig() {
        return this.runRequest('get-tex-config', {});
    }
    async getSelection() {
        return this.runRequest('get-selection', {});
    }
    updateStyles() {
        this._element.send('style', { styles: util_2.getPreviewStyles(true) });
    }
    async runRequest(request, args) {
        const id = this.replyCallbackId++;
        return new Promise((resolve) => {
            this.replyCallbacks.set(id, {
                request: request,
                callback: (result) => {
                    this.replyCallbacks.delete(id);
                    resolve(result);
                },
            });
            const newargs = Object.assign({ id }, args);
            this._element.send(request, newargs);
        });
    }
    async prepareSaveToPDF(opts) {
        const [width, height] = getPageWidth(opts.pageSize);
        return this.runRequest('set-width', {
            width: opts.landscape ? height : width,
        });
    }
    async finishSaveToPDF() {
        return this.runRequest('set-width', { width: undefined });
    }
}
exports.WebviewHandler = WebviewHandler;
function parsePageSize(size) {
    if (!size)
        return undefined;
    const rx = /^([\d.,]+)(cm|mm|in)?x([\d.,]+)(cm|mm|in)?$/i;
    const res = size.replace(/\s*/g, '').match(rx);
    if (res) {
        const width = parseFloat(res[1]);
        const wunit = res[2];
        const height = parseFloat(res[3]);
        const hunit = res[4];
        return {
            width: convert(width, wunit),
            height: convert(height, hunit),
        };
    }
    else {
        return undefined;
    }
}
function convert(val, unit) {
    return val * unitInMicrons(unit);
}
function unitInMicrons(unit = 'mm') {
    switch (unit) {
        case 'mm':
            return 1000;
        case 'cm':
            return 10000;
        case 'in':
            return 25400;
    }
}
function getPageWidth(pageSize) {
    switch (pageSize) {
        case 'A3':
            return [297, 420];
        case 'A4':
            return [210, 297];
        case 'A5':
            return [148, 210];
        case 'Legal':
            return [216, 356];
        case 'Letter':
            return [216, 279];
        case 'Tabloid':
            return [279, 432];
        default:
            return [pageSize.width / 1000, pageSize.height / 1000];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vidmlldy1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL21hcmtkb3duLXByZXZpZXctdmlldy93ZWJ2aWV3LWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx5QkFBd0I7QUFDeEIsK0JBQWlFO0FBQ2pFLHVDQUE0QztBQUM1QyxrREFBa0Q7QUFFbEQsa0NBQW1EO0FBRW5ELGlDQUF5QztBQVd6QyxNQUFhLGNBQWM7SUFjekIsWUFBWSxJQUFnQjtRQWJaLFlBQU8sR0FBRyxJQUFJLGNBQU8sRUFLbEMsQ0FBQTtRQUNPLGdCQUFXLEdBQUcsSUFBSSwwQkFBbUIsRUFBRSxDQUFBO1FBRXpDLGNBQVMsR0FBRyxLQUFLLENBQUE7UUFDakIsY0FBUyxHQUFHLENBQUMsQ0FBQTtRQUNiLG1CQUFjLEdBQUcsSUFBSSxHQUFHLEVBQStCLENBQUE7UUFDdkQsb0JBQWUsR0FBRyxDQUFDLENBQUE7UUFHekIsSUFBSSxDQUFDLFFBQVEsR0FBRyxRQUFRLENBQUMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxDQUFBO1FBQ2pELElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyx1QkFBdUIsRUFBRSxxQkFBcUIsQ0FBQyxDQUFBO1FBQzNFLElBQUksQ0FBQyxRQUFRLENBQUMsa0JBQWtCLEdBQUcsTUFBTSxDQUFBO1FBQ3pDLElBQUksQ0FBQyxRQUFRLENBQUMsZUFBZSxHQUFHLE1BQU0sQ0FBQTtRQUN0QyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsR0FBRyxXQUFXLFNBQVMsNkJBQTZCLENBQUE7UUFDckUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQTtRQUNsQyxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFBO1FBQ25DLElBQUksQ0FBQyxRQUFRLENBQUMsZ0JBQWdCLENBQzVCLGFBQWEsRUFDYixDQUFD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QUM7U0FDL0IsQ0FBQTtLQUNGO1NBQU07UUFDTCxPQUFPLFNBQVMsQ0FBQTtLQUNqQjtBQUNILENBQUM7QUFTRCxTQUFTLE9BQU8sQ0FBQyxHQUFXLEVBQUUsSUFBVztJQUN2QyxPQUFPLEdBQUcsR0FBRyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUE7QUFDbEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLE9BQWEsSUFBSTtJQUN0QyxRQUFRLElBQUksRUFBRTtRQUNaLEtBQUssSUFBSTtZQUNQLE9BQU8sSUFBSSxDQUFBO1FBQ2IsS0FBSyxJQUFJO1lBQ1AsT0FBTyxLQUFLLENBQUE7UUFDZCxLQUFLLElBQUk7WUFDUCxPQUFPLEtBQUssQ0FBQTtLQUNmO0FBQ0gsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLFFBQWtCO0lBQ3RDLFFBQVEsUUFBUSxFQUFFO1FBQ2hCLEtBQUssSUFBSTtZQUNQLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxJQUFJO1lBQ1AsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQixLQUFLLElBQUk7WUFDUCxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CLEtBQUssT0FBTztZQUNWLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxRQUFRO1lBQ1gsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQixLQUFLLFNBQVM7WUFDWixPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CO1lBQ0UsT0FBTyxDQUFDLFFBQVEsQ0FBQyxLQUFLLEdBQUcsSUFBSSxFQUFFLFFBQVEsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLENBQUE7S0FDekQ7QUFDSCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMnXG5pbXBvcnQgeyBFbWl0dGVyLCBDb21wb3NpdGVEaXNwb3NhYmxlLCBDb25maWdWYWx1ZXMgfSBmcm9tICdhdG9tJ1xuaW1wb3J0IHsgV2Vidmlld1RhZywgc2hlbGwgfSBmcm9tICdlbGVjdHJvbidcbmltcG9ydCBmaWxlVXJpVG9QYXRoID0gcmVxdWlyZSgnZmlsZS11cmktdG8tcGF0aCcpXG5cbmltcG9ydCB7IGhhbmRsZVByb21pc2UsIGF0b21Db25maWcgfSBmcm9tICcuLi91dGlsJ1xuaW1wb3J0IHsgUmVxdWVzdFJlcGx5TWFwLCBDaGFubmVsTWFwIH0gZnJvbSAnLi4vLi4vc3JjLWNsaWVudC9pcGMnXG5pbXBvcnQgeyBnZXRQcmV2aWV3U3R5bGVzIH0gZnJvbSAnLi91dGlsJ1xuXG5leHBvcnQgdHlwZSBSZXBseUNhbGxiYWNrU3RydWN0PFxuICBUIGV4dGVuZHMga2V5b2YgUmVxdWVzdFJlcGx5TWFwID0ga2V5b2YgUmVxdWVzdFJlcGx5TWFwXG4+ID0ge1xuICBbSyBpbiBrZXlvZiBSZXF1ZXN0UmVwbHlNYXBdOiB7XG4gICAgcmVxdWVzdDogS1xuICAgIGNhbGxiYWNrOiAocmVwbHk6IFJlcXVlc3RSZXBseU1hcFtLXSkgPT4gdm9pZFxuICB9XG59W1RdXG5cbmV4cG9ydCBjbGFzcyBXZWJ2aWV3SGFuZGxlciB7XG4gIHB1YmxpYyByZWFkb25seSBlbWl0dGVyID0gbmV3IEVtaXR0ZXI8XG4gICAge30sXG4gICAge1xuICAgICAgJ2RpZC1zY3JvbGwtcHJldmlldyc6IHsgbWluOiBudW1iZXI7IG1heDogbnVtYmVyIH1cbiAgICB9XG4gID4oKVxuICBwcm90ZWN0ZWQgZGlzcG9zYWJsZXMgPSBuZXcgQ29tcG9zaXRlRGlzcG9zYWJsZSgpXG4gIHByaXZhdGUgcmVhZG9ubHkgX2VsZW1lbnQ6IFdlYnZpZXdUYWdcbiAgcHJpdmF0ZSBkZXN0cm95ZWQgPSBmYWxzZVxuICBwcml2YXRlIHpvb21MZXZlbCA9IDBcbiAgcHJpdmF0ZSByZXBseUNhbGxiYWNrcyA9IG5ldyBNYXA8bnVtYmVyLCBSZXBseUNhbGxiYWNrU3RydWN0PigpXG4gIHByaXZhdGUgcmVwbHlDYWxsYmFja0lkID0gMFxuXG4gIGNvbnN0cnVjdG9yKGluaXQ6ICgpID0+IHZvaWQpIHtcbiAgICB0aGlzLl9lbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnd2VidmlldycpXG4gICAgdGhpcy5fZWxlbWVudC5jbGFzc0xpc3QuYWRkKCdtYXJrZG93bi1wcmV2aWV3LXBsdXMnLCAnbmF0aXZlLWtleS1iaW5kaW5ncycpXG4gICAgdGhpcy5fZWxlbWVudC5kaXNhYmxld2Vic2VjdXJpdHkgPSAndHJ1ZSdcbiAgICB0aGlzLl9lbGVtZW50Lm5vZGVpbnRlZ3JhdGlvbiA9ICd0cnVlJ1xuICAgIHRoaXMuX2VsZW1lbnQuc3JjID0gYGZpbGU6Ly8vJHtfX2Rpcm5hbWV9Ly4uLy4uL2NsaWVudC90ZW1wbGF0ZS5odG1sYFxuICAgIHRoaXMuX2VsZW1lbnQuc3R5bGUud2lkdGggPSAnMTAwJSdcbiAgICB0aGlzLl9lbGVtZW50LnN0eWxlLmhlaWdodCA9ICcxMDAlJ1xuICAgIHRoaXMuX2VsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcbiAgICAgICdpcGMtbWVzc2FnZScsXG4gICAgICAoZTogRWxlY3Ryb24uSXBjTWVzc2FnZUV2ZW50Q3VzdG9tKSA9PiB7XG4gICAgICAgIHN3aXRjaCAoZS5jaGFubmVsKSB7XG4gICAgICAgICAgY2FzZSAnem9vbS1pbic6XG4gICAgICAgICAgICB0aGlzLnpvb21JbigpXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGNhc2UgJ3pvb20tb3V0JzpcbiAgICAgICAgICAgIHRoaXMuem9vbU91dCgpXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGNhc2UgJ2RpZC1zY3JvbGwtcHJldmlldyc6XG4gICAgICAgICAgICB0aGlzLmVtaXR0ZXIuZW1pdCgnZGlkLXNjcm9sbC1wcmV2aWV3JywgZS5hcmdzWzBdKVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICBjYXNlICd1bmNhdWdodC1lcnJvcic6IHtcbiAgICAgICAgICAgIGNvbnN0IGVyciA9IGUuYXJnc1swXVxuICAgICAgICAgICAgY29uc3QgbmV3RXJyID0gbmV3IEVycm9yKClcbiAgICAgICAgICAgIGF0b20ubm90aWZpY2F0aW9ucy5hZGRGYXRhbEVycm9yKFxuICAgICAgICAgICAgICBgVW5jYXVnaHQgZXJyb3IgJHtcbiAgICAgICAgICAgICAgICBlcnIubmFtZVxuICAgICAgICAgICAgICB9IGluIG1hcmtkb3duLXByZXZpZXctcGx1cyB3ZWJ2aWV3IGNsaWVudGAsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBkaXNtaXNzYWJsZTogdHJ1ZSxcbiAgICAgICAgICAgICAgICBzdGFjazogbmV3RXJyLnN0YWNrLFxuICAgICAgICAgICAgICAgIGRldGFpbDogYCR7ZXJyLm1lc3NhZ2V9XFxuXFxuc3RhY2s6XFxuJHtlcnIuc3RhY2t9YCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIHJlcGxpZXNcbiAgICAgICAgICBjYXNlICdyZXF1ZXN0LXJlcGx5Jzoge1xuICAgICAgICAgICAgY29uc3QgeyBpZCwgcmVxdWVzdCwgcmVzdWx0IH0gPSBlLmFyZ3NbMF1cbiAgICAgICAgICAgIGNvbnN0IGNiID0gdGhpcy5yZXBseUNhbGxiYWNrcy5nZXQoaWQpXG4gICAgICAgICAgICBpZiAoY2IgJiYgcmVxdWVzdCA9PT0gY2IucmVxdWVzdCkge1xuICAgICAgICAgICAgICBjb25zdCBjYWxsYmFjazogKHI6IGFueSkgPT4gdm9pZCA9IGNiLmNhbGxiYWNrXG4gICAgICAgICAgICAgIGNhbGxiYWNrKHJlc3VsdClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgICB0aGlzLl9lbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3dpbGwtbmF2aWdhdGUnLCBhc3luYyAoZSkgPT4ge1xuICAgICAgY29uc3QgZXh0cyA9IGF0b21Db25maWcoKS5wcmV2aWV3Q29uZmlnLnNoZWxsT3BlbkZpbGVFeHRlbnNpb25zXG4gICAgICBjb25zdCBmb3JjZU9wZW5FeHRlcm5hbCA9IGV4dHMuc29tZSgoZXh0KSA9PlxuICAgICAgICBlLnVybC50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKGAuJHtleHQudG9Mb3dlckNhc2UoKX1gKSxcbiAgICAgIClcbiAgICAgIGlmIChlLnVybC5zdGFydHNXaXRoKCdmaWxlOi8vJykgJiYgIWZvcmNlT3BlbkV4dGVybmFsKSB7XG4gICAgICAgIGhhbmRsZVByb21pc2UoYXRvbS53b3Jrc3BhY2Uub3BlbihmaWxlVXJpVG9QYXRoKGUudXJsKSkpXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzaGVsbC5vcGVuRXh0ZXJuYWwoZS51cmwpXG4gICAgICB9XG4gICAgfSlcblxuICAgIHRoaXMuZGlzcG9zYWJsZXMuYWRkKFxuICAgICAgYXRvbS5zdHlsZXMub25EaWRBZGRTdHlsZUVsZW1lbnQoKCkgPT4ge1xuICAgICAgICB0aGlzLnVwZGF0ZVN0eWxlcygpXG4gICAgICB9KSxcbiAgICAgIGF0b20uc3R5bGVzLm9uRGlkUmVtb3ZlU3R5bGVFbGVtZW50KCgpID0+IHtcbiAgICAgICAgdGhpcy51cGRhdGVTdHlsZXMoKVxuICAgICAgfSksXG4gICAgICBhdG9tLnN0eWxlcy5vbkRpZFVwZGF0ZVN0eWxlRWxlbWVudCgoKSA9PiB7XG4gICAgICAgIHRoaXMudXBkYXRlU3R5bGVzKClcbiAgICAgIH0pLFxuICAgIClcblxuICAgIGNvbnN0IG9ubG9hZCA9ICgpID0+IHtcbiAgICAgIGlmICh0aGlzLmRlc3Ryb3llZCkgcmV0dXJuXG4gICAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgICAgIHRoaXMudXBkYXRlU3R5bGVzKClcbiAgICAgIGluaXQoKVxuICAgIH1cbiAgICB0aGlzLl9lbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2RvbS1yZWFkeScsIG9ubG9hZClcbiAgfVxuXG4gIHB1YmxpYyBnZXQgZWxlbWVudCgpOiBIVE1MRWxlbWVudCB7XG4gICAgcmV0dXJuIHRoaXMuX2VsZW1lbnRcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBydW5KUzxUPihqczogc3RyaW5nKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlKSA9PlxuICAgICAgdGhpcy5fZWxlbWVudC5leGVjdXRlSmF2YVNjcmlwdChqcywgZmFsc2UsIHJlc29sdmUpLFxuICAgIClcbiAgfVxuXG4gIHB1YmxpYyBkZXN0cm95KCkge1xuICAgIGlmICh0aGlzLmRlc3Ryb3llZCkgcmV0dXJuXG4gICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlXG4gICAgdGhpcy5kaXNwb3NhYmxlcy5kaXNwb3NlKClcbiAgICB0aGlzLl9lbGVtZW50LnJlbW92ZSgpXG4gIH1cblxuICBwdWJsaWMgYXN5bmMgdXBkYXRlKGh0bWw6IHN0cmluZywgcmVuZGVyTGFUZVg6IGJvb2xlYW4pIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVybiB1bmRlZmluZWRcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCd1cGRhdGUtcHJldmlldycsIHtcbiAgICAgIGh0bWwsXG4gICAgICByZW5kZXJMYVRlWCxcbiAgICB9KVxuICB9XG5cbiAgcHVibGljIHNldFNvdXJjZU1hcChtYXA6IHtcbiAgICBbbGluZTogbnVtYmVyXTogeyB0YWc6IHN0cmluZzsgaW5kZXg6IG51bWJlciB9W11cbiAgfSkge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnc2V0LXNvdXJjZS1tYXAnPignc2V0LXNvdXJjZS1tYXAnLCB7IG1hcCB9KVxuICB9XG5cbiAgcHVibGljIHNldEJhc2VQYXRoKHBhdGg/OiBzdHJpbmcpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3NldC1iYXNlLXBhdGgnPignc2V0LWJhc2UtcGF0aCcsIHsgcGF0aCB9KVxuICB9XG5cbiAgcHVibGljIGluaXQoXG4gICAgYXRvbUhvbWU6IHN0cmluZyxcbiAgICBtYXRoSmF4Q29uZmlnOiBNYXRoSmF4Q29uZmlnLFxuICAgIG1hdGhKYXhSZW5kZXJlciA9IGF0b21Db25maWcoKS5tYXRoQ29uZmlnLmxhdGV4UmVuZGVyZXIsXG4gICkge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnaW5pdCc+KCdpbml0Jywge1xuICAgICAgYXRvbUhvbWUsXG4gICAgICBtYXRoSmF4Q29uZmlnLFxuICAgICAgbWF0aEpheFJlbmRlcmVyLFxuICAgIH0pXG4gIH1cblxuICBwdWJsaWMgdXBkYXRlSW1hZ2VzKG9sZFNvdXJjZTogc3RyaW5nLCB2ZXJzaW9uOiBudW1iZXIgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3VwZGF0ZS1pbWFnZXMnPigndXBkYXRlLWltYWdlcycsIHtcbiAgICAgIG9sZHNyYzogb2xkU291cmNlLFxuICAgICAgdjogdmVyc2lvbixcbiAgICB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHNhdmVUb1BERihmaWxlUGF0aDogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3B0cyA9IGF0b21Db25maWcoKS5zYXZlQ29uZmlnLnNhdmVUb1BERk9wdGlvbnNcbiAgICBjb25zdCBjdXN0b21QYWdlU2l6ZSA9IHBhcnNlUGFnZVNpemUob3B0cy5jdXN0b21QYWdlU2l6ZSlcbiAgICBjb25zdCBwYWdlU2l6ZSA9IG9wdHMucGFnZVNpemUgPT09ICdDdXN0b20nID8gY3VzdG9tUGFnZVNpemUgOiBvcHRzLnBhZ2VTaXplXG4gICAgaWYgKHBhZ2VTaXplID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBwYXJzZSBjdXN0b20gcGFnZSBzaXplOiAke29wdHMuY3VzdG9tUGFnZVNpemV9YCxcbiAgICAgIClcbiAgICB9XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gYXdhaXQgdGhpcy5nZXRTZWxlY3Rpb24oKVxuICAgIGNvbnN0IHByaW50U2VsZWN0aW9uT25seSA9IHNlbGVjdGlvbiA/IG9wdHMucHJpbnRTZWxlY3Rpb25Pbmx5IDogZmFsc2VcbiAgICBjb25zdCBuZXdPcHRzID0ge1xuICAgICAgLi4ub3B0cyxcbiAgICAgIHBhZ2VTaXplLFxuICAgICAgcHJpbnRTZWxlY3Rpb25Pbmx5LFxuICAgIH1cbiAgICBhd2FpdCB0aGlzLnByZXBhcmVTYXZlVG9QREYobmV3T3B0cylcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNlPEJ1ZmZlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAvLyBUT0RPOiBDb21wbGFpbiBvbiBFbGVjdHJvblxuICAgICAgICB0aGlzLl9lbGVtZW50LnByaW50VG9QREYobmV3T3B0cyBhcyBhbnksIChlcnJvciwgZGF0YSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH0pXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGZzLndyaXRlRmlsZShmaWxlUGF0aCwgZGF0YSwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICB9XG4gICAgICAgICAgcmVzb2x2ZSgpXG4gICAgICAgIH0pXG4gICAgICB9KVxuICAgIH0gZmluYWxseSB7XG4gICAgICBoYW5kbGVQcm9taXNlKHRoaXMuZmluaXNoU2F2ZVRvUERGKCkpXG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN5bmMobGluZTogbnVtYmVyLCBmbGFzaDogYm9vbGVhbikge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnc3luYyc+KCdzeW5jJywgeyBsaW5lLCBmbGFzaCB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNTb3VyY2UoKSB7XG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgnc3luYy1zb3VyY2UnLCB7fSlcbiAgfVxuXG4gIHB1YmxpYyBzY3JvbGxTeW5jKGZpcnN0TGluZTogbnVtYmVyLCBsYXN0TGluZTogbnVtYmVyKSB7XG4gICAgdGhpcy5fZWxlbWVudC5zZW5kPCdzY3JvbGwtc3luYyc+KCdzY3JvbGwtc3luYycsIHsgZmlyc3RMaW5lLCBsYXN0TGluZSB9KVxuICB9XG5cbiAgcHVibGljIHpvb21JbigpIHtcbiAgICB0aGlzLnpvb21MZXZlbCArPSAwLjFcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyB6b29tT3V0KCkge1xuICAgIHRoaXMuem9vbUxldmVsIC09IDAuMVxuICAgIHRoaXMuX2VsZW1lbnQuc2V0Wm9vbUxldmVsKHRoaXMuem9vbUxldmVsKVxuICB9XG5cbiAgcHVibGljIHJlc2V0Wm9vbSgpIHtcbiAgICB0aGlzLnpvb21MZXZlbCA9IDBcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyBwcmludCgpIHtcbiAgICB0aGlzLl9lbGVtZW50LnByaW50KClcbiAgfVxuXG4gIHB1YmxpYyBvcGVuRGV2VG9vbHMoKSB7XG4gICAgdGhpcy5fZWxlbWVudC5vcGVuRGV2VG9vbHMoKVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlbG9hZCgpIHtcbiAgICBhd2FpdCB0aGlzLnJ1blJlcXVlc3QoJ3JlbG9hZCcsIHt9KVxuICAgIHRoaXMuX2VsZW1lbnQucmVsb2FkKClcbiAgfVxuXG4gIHB1YmxpYyBlcnJvcihtc2c6IHN0cmluZykge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnZXJyb3InPignZXJyb3InLCB7IG1zZyB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFRlWENvbmZpZygpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtdGV4LWNvbmZpZycsIHt9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFNlbGVjdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtc2VsZWN0aW9uJywge30pXG4gIH1cblxuICBwdWJsaWMgdXBkYXRlU3R5bGVzKCkge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnc3R5bGUnPignc3R5bGUnLCB7IHN0eWxlczogZ2V0UHJldmlld1N0eWxlcyh0cnVlKSB9KVxuICB9XG5cbiAgcHJvdGVjdGVkIGFzeW5jIHJ1blJlcXVlc3Q8VCBleHRlbmRzIGtleW9mIFJlcXVlc3RSZXBseU1hcD4oXG4gICAgcmVxdWVzdDogVCxcbiAgICBhcmdzOiB7IFtLIGluIEV4Y2x1ZGU8a2V5b2YgQ2hhbm5lbE1hcFtUXSwgJ2lkJz5dOiBDaGFubmVsTWFwW1RdW0tdIH0sXG4gICkge1xuICAgIGNvbnN0IGlkID0gdGhpcy5yZXBseUNhbGxiYWNrSWQrK1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxSZXF1ZXN0UmVwbHlNYXBbVF0+KChyZXNvbHZlKSA9PiB7XG4gICAgICB0aGlzLnJlcGx5Q2FsbGJhY2tzLnNldChpZCwge1xuICAgICAgICByZXF1ZXN0OiByZXF1ZXN0LFxuICAgICAgICBjYWxsYmFjazogKHJlc3VsdDogUmVxdWVzdFJlcGx5TWFwW1RdKSA9PiB7XG4gICAgICAgICAgdGhpcy5yZXBseUNhbGxiYWNrcy5kZWxldGUoaWQpXG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpXG4gICAgICAgIH0sXG4gICAgICB9IGFzIFJlcGx5Q2FsbGJhY2tTdHJ1Y3Q8VD4pXG4gICAgICBjb25zdCBuZXdhcmdzID0gT2JqZWN0LmFzc2lnbih7IGlkIH0sIGFyZ3MpXG4gICAgICB0aGlzLl9lbGVtZW50LnNlbmQ8VD4ocmVxdWVzdCwgbmV3YXJncylcbiAgICB9KVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwcmVwYXJlU2F2ZVRvUERGKG9wdHM6IHtcbiAgICBwYWdlU2l6ZTogUGFnZVNpemVcbiAgICBsYW5kc2NhcGU6IGJvb2xlYW5cbiAgfSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IFt3aWR0aCwgaGVpZ2h0XSA9IGdldFBhZ2VXaWR0aChvcHRzLnBhZ2VTaXplKVxuICAgIHJldHVybiB0aGlzLnJ1blJlcXVlc3QoJ3NldC13aWR0aCcsIHtcbiAgICAgIHdpZHRoOiBvcHRzLmxhbmRzY2FwZSA/IGhlaWdodCA6IHdpZHRoLFxuICAgIH0pXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGZpbmlzaFNhdmVUb1BERigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdzZXQtd2lkdGgnLCB7IHdpZHRoOiB1bmRlZmluZWQgfSlcbiAgfVxufVxuXG50eXBlIFVuaXQgPSAnbW0nIHwgJ2NtJyB8ICdpbidcblxuZnVuY3Rpb24gcGFyc2VQYWdlU2l6ZShzaXplOiBzdHJpbmcpIHtcbiAgaWYgKCFzaXplKSByZXR1cm4gdW5kZWZpbmVkXG4gIGNvbnN0IHJ4ID0gL14oW1xcZC4sXSspKGNtfG1tfGluKT94KFtcXGQuLF0rKShjbXxtbXxpbik/JC9pXG4gIGNvbnN0IHJlcyA9IHNpemUucmVwbGFjZSgvXFxzKi9nLCAnJykubWF0Y2gocngpXG4gIGlmIChyZXMpIHtcbiAgICBjb25zdCB3aWR0aCA9IHBhcnNlRmxvYXQocmVzWzFdKVxuICAgIGNvbnN0IHd1bml0ID0gcmVzWzJdIGFzIFVuaXQgfCB1bmRlZmluZWRcbiAgICBjb25zdCBoZWlnaHQgPSBwYXJzZUZsb2F0KHJlc1szXSlcbiAgICBjb25zdCBodW5pdCA9IHJlc1s0XSBhcyBVbml0IHwgdW5kZWZpbmVkXG4gICAgcmV0dXJuIHtcbiAgICAgIHdpZHRoOiBjb252ZXJ0KHdpZHRoLCB3dW5pdCksXG4gICAgICBoZWlnaHQ6IGNvbnZlcnQoaGVpZ2h0LCBodW5pdCksXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHJldHVybiB1bmRlZmluZWRcbiAgfVxufVxuXG50eXBlIFBhZ2VTaXplID1cbiAgfCBFeGNsdWRlPFxuICAgICAgQ29uZmlnVmFsdWVzWydtYXJrZG93bi1wcmV2aWV3LXBsdXMuc2F2ZUNvbmZpZy5zYXZlVG9QREZPcHRpb25zLnBhZ2VTaXplJ10sXG4gICAgICAnQ3VzdG9tJ1xuICAgID5cbiAgfCB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH1cblxuZnVuY3Rpb24gY29udmVydCh2YWw6IG51bWJlciwgdW5pdD86IFVuaXQpIHtcbiAgcmV0dXJuIHZhbCAqIHVuaXRJbk1pY3JvbnModW5pdClcbn1cblxuZnVuY3Rpb24gdW5pdEluTWljcm9ucyh1bml0OiBVbml0ID0gJ21tJykge1xuICBzd2l0Y2ggKHVuaXQpIHtcbiAgICBjYXNlICdtbSc6XG4gICAgICByZXR1cm4gMTAwMFxuICAgIGNhc2UgJ2NtJzpcbiAgICAgIHJldHVybiAxMDAwMFxuICAgIGNhc2UgJ2luJzpcbiAgICAgIHJldHVybiAyNTQwMFxuICB9XG59XG5cbmZ1bmN0aW9uIGdldFBhZ2VXaWR0aChwYWdlU2l6ZTogUGFnZVNpemUpIHtcbiAgc3dpdGNoIChwYWdlU2l6ZSkge1xuICAgIGNhc2UgJ0EzJzpcbiAgICAgIHJldHVybiBbMjk3LCA0MjBdXG4gICAgY2FzZSAnQTQnOlxuICAgICAgcmV0dXJuIFsyMTAsIDI5N11cbiAgICBjYXNlICdBNSc6XG4gICAgICByZXR1cm4gWzE0OCwgMjEwXVxuICAgIGNhc2UgJ0xlZ2FsJzpcbiAgICAgIHJldHVybiBbMjE2LCAzNTZdXG4gICAgY2FzZSAnTGV0dGVyJzpcbiAgICAgIHJldHVybiBbMjE2LCAyNzldXG4gICAgY2FzZSAnVGFibG9pZCc6XG4gICAgICByZXR1cm4gWzI3OSwgNDMyXVxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gW3BhZ2VTaXplLndpZHRoIC8gMTAwMCwgcGFnZVNpemUuaGVpZ2h0IC8gMTAwMF1cbiAgfVxufVxuIl19