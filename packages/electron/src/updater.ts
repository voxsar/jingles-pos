import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, ipcMain, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';

export type UpdatePolicy = 'automatic' | 'ask' | 'manual';
type State = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error';
interface Preferences { policy: UpdatePolicy; skippedVersion: string | null }
interface Status { state: State; currentVersion: string; availableVersion: string | null; progressPercent: number | null; message: string; policy: UpdatePolicy; portable: boolean }

let preferences: Preferences = { policy: 'ask', skippedVersion: null };
let status: Status;
let checking = false;
let manualCheck = false;
let timer: NodeJS.Timeout | null = null;

const preferencesPath = () => path.join(app.getPath('userData'), 'update-preferences.json');
function loadPreferences() {
	try {
		const value = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')) as Partial<Preferences>;
		preferences = {
			policy: ['automatic', 'ask', 'manual'].includes(value.policy ?? '') ? value.policy as UpdatePolicy : 'ask',
			skippedVersion: typeof value.skippedVersion === 'string' ? value.skippedVersion : null,
		};
	} catch { preferences = { policy: 'ask', skippedVersion: null }; }
}
function savePreferences() {
	fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
	fs.writeFileSync(preferencesPath(), JSON.stringify(preferences, null, 2), 'utf8');
}
function showMessage(options: Electron.MessageBoxOptions) {
	const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}
function updateStatus(next: Partial<Status>) {
	status = { ...status, ...next, policy: preferences.policy };
	BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('updater:status', status));
}
function configureFeed(environmentVariable: string) {
	let url = process.env[environmentVariable]?.trim();
	let channel = process.env.JINGLES_UPDATE_CHANNEL?.trim() || 'latest';
	try {
		if (!url) {
			const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'update-config.json'), 'utf8')) as { url?: string; channel?: string };
			url = config.url?.trim();
			channel = config.channel?.trim() || channel;
		}
	} catch { /* The builder-generated app-update.yml is also supported. */ }
	if (!url) return fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Update feed must use HTTPS.');
	autoUpdater.setFeedURL({ provider: 'generic', url: parsed.toString().replace(/\/$/, ''), channel });
	autoUpdater.channel = channel;
	return true;
}
async function download() {
	updateStatus({ state: 'downloading', progressPercent: 0, message: 'Downloading update...' });
	try { await autoUpdater.downloadUpdate(); }
	catch (error) { updateStatus({ state: 'error', message: `Download failed: ${String(error)}` }); }
}
async function offer(info: UpdateInfo) {
	if (!manualCheck && preferences.skippedVersion === info.version) return;
	if (!manualCheck && preferences.policy === 'automatic') return download();
	const result = await showMessage({
		type: 'info', title: 'Update available', message: `Version ${info.version} is available`,
		detail: `You are using ${app.getVersion()}. Download it in the background now?`,
		buttons: ['Download now', 'Later', 'Skip this version'], defaultId: 0, cancelId: 1, noLink: true,
	});
	if (result.response === 0) await download();
	if (result.response === 2) { preferences.skippedVersion = info.version; savePreferences(); }
}
export async function checkForUpdates(showResult = true) {
	if (status.state === 'disabled') {
		if (showResult) await showMessage({ type: 'info', title: 'Updates unavailable', message: status.message });
		return status;
	}
	if (checking || status.state === 'downloading') return status;
	checking = true; manualCheck = showResult;
	updateStatus({ state: 'checking', message: 'Checking for updates...', progressPercent: null });
	try { await autoUpdater.checkForUpdates(); }
	catch (error) {
		updateStatus({ state: 'error', message: `Update check failed: ${String(error)}` });
		if (showResult) await showMessage({ type: 'error', title: 'Update check failed', message: status.message });
	} finally { checking = false; manualCheck = false; }
	return status;
}
export async function chooseUpdatePolicy() {
	const result = await showMessage({
		type: 'question', title: 'Update preferences', message: 'How should this app handle updates?',
		detail: 'Automatic downloads in the background. Ask requests approval. Manual checks only when requested.',
		buttons: ['Automatic', 'Ask before downloading', 'Manual only', 'Cancel'],
		defaultId: preferences.policy === 'automatic' ? 0 : preferences.policy === 'ask' ? 1 : 2, cancelId: 3, noLink: true,
	});
	if (result.response < 3) {
		preferences = { policy: (['automatic', 'ask', 'manual'] as const)[result.response], skippedVersion: null };
		savePreferences(); updateStatus({ message: `Update policy changed to ${preferences.policy}.` }); schedule();
	}
	return preferences.policy;
}
export function getUpdateMenu(): MenuItemConstructorOptions {
	return { label: 'Updates', submenu: [
		{ label: 'Check for Updates...', click: () => void checkForUpdates(true) },
		{ label: 'Update Preferences...', click: () => void chooseUpdatePolicy() },
		{ type: 'separator' }, { label: `Current version ${app.getVersion()}`, enabled: false },
	] };
}
function schedule() {
	if (timer) clearTimeout(timer); timer = null;
	if (preferences.policy === 'manual' || status.state === 'disabled') return;
	timer = setTimeout(() => {
		void checkForUpdates(false);
		timer = setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000); timer.unref?.();
	}, 15_000); timer.unref?.();
}
export function initializeUpdater(environmentVariable: string) {
	loadPreferences();
	const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
	status = { state: 'idle', currentVersion: app.getVersion(), availableVersion: null, progressPercent: null, message: 'Ready to check for updates.', policy: preferences.policy, portable };
	let configured = false;
	try { configured = app.isPackaged && !portable && configureFeed(environmentVariable); }
	catch (error) { updateStatus({ state: 'error', message: String(error) }); }
	if (!configured && status.state !== 'error') updateStatus({ state: 'disabled', message: !app.isPackaged ? 'Updates are only enabled in packaged builds.' : portable ? 'Portable EXEs cannot safely self-update. Install the NSIS edition once for automatic updates.' : 'No update feed is configured.' });
	if (configured) {
		autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.allowPrerelease = false;
		autoUpdater.on('update-available', (info) => { updateStatus({ state: 'available', availableVersion: info.version, message: `Version ${info.version} is available.` }); void offer(info); });
		autoUpdater.on('update-not-available', async () => { updateStatus({ state: 'current', availableVersion: null, message: 'You have the latest version.' }); if (manualCheck) await showMessage({ type: 'info', title: 'No updates available', message: status.message }); });
		autoUpdater.on('download-progress', (progress: ProgressInfo) => updateStatus({ state: 'downloading', progressPercent: Math.round(progress.percent), message: `Downloading update... ${Math.round(progress.percent)}%` }));
		autoUpdater.on('update-downloaded', async (info) => {
			updateStatus({ state: 'downloaded', availableVersion: info.version, progressPercent: 100, message: `Version ${info.version} is ready.` });
			const result = await showMessage({ type: 'info', title: 'Update ready', message: `Version ${info.version} is ready`, detail: 'Restart now, or install automatically when the app is next closed.', buttons: ['Restart and install', 'Later'], defaultId: 0, cancelId: 1, noLink: true });
			if (result.response === 0) autoUpdater.quitAndInstall(false, true);
		});
		autoUpdater.on('error', (error) => updateStatus({ state: 'error', message: `Updater error: ${error.message}` }));
	}
	ipcMain.handle('updater:get-status', () => status);
	ipcMain.handle('updater:check', () => checkForUpdates(true));
	ipcMain.handle('updater:choose-policy', () => chooseUpdatePolicy());
	ipcMain.handle('updater:install', () => { if (status.state !== 'downloaded') return false; autoUpdater.quitAndInstall(false, true); return true; });
	schedule();
}
