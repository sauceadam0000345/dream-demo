import pytest
import requests
from appium import webdriver
from appium.options.android import UiAutomator2Options
import os

from sauce_result_reporter import report_result, report_result_after_quit

# Sauce Labs credentials
SAUCE_USERNAME = os.getenv("SAUCE_USERNAME")
SAUCE_ACCESS_KEY = os.getenv("SAUCE_ACCESS_KEY")

# Sauce Labs URL
SAUCE_URL = f"https://{SAUCE_USERNAME}:{SAUCE_ACCESS_KEY}@ondemand.us-west-1.saucelabs.com:443/wd/hub"

# App configuration
APP_PACKAGE = "com.example.flowershop"
APP_ACTIVITY = "com.example.flowershop.MainActivity"

# Default RDC device when none is specified via env or fixture parameter.
DEFAULT_SAUCE_DEVICE_NAME = os.getenv("SAUCE_DEVICE_NAME", "Google Pixel 8")
DEFAULT_SAUCE_PLATFORM_VERSION = os.getenv("SAUCE_PLATFORM_VERSION", "14")

def _sauce_device_matrix():
    """
    Build the device matrix for the parametrized Sauce fixture.
    If SAUCE_DEVICE_NAME is set we run only that device (handy for demos where
    you grabbed a specific device from the Sauce RDC VS Code extension).
    Otherwise we fall back to a small default matrix.
    """
    if os.getenv("SAUCE_DEVICE_NAME"):
        return [{
            "name": DEFAULT_SAUCE_DEVICE_NAME,
            "platform_version": DEFAULT_SAUCE_PLATFORM_VERSION,
        }]
    return [
        {"name": "Google Pixel 8", "platform_version": "14"},
        {"name": "Samsung Galaxy S23", "platform_version": "13"},
    ]


def get_sauce_options(test_name: str, device_name: str) -> UiAutomator2Options:
    """Configure options for Sauce Labs Real Device Cloud."""
    options = UiAutomator2Options()
    
    # App can be uploaded to Sauce Labs storage or referenced by URL
    options.app = os.getenv("SAUCE_APP_ID", "storage:filename=flowershop.apk")
    
    # Device capabilities
    options.platform_name = "Android"
    options.device_name = device_name
    options.automation_name = "UiAutomator2"
    
    # Auto-grant Android permissions so "Allow" popups never appear
    options.set_capability("autoGrantPermissions", True)
    
    # Sauce Labs specific options
    sauce_options = {
        "username": SAUCE_USERNAME,
        "accessKey": SAUCE_ACCESS_KEY,
        "build": os.getenv("SAUCE_BUILD_NAME", "FlowerShop-Android-Build-1"),
        "name": test_name,
        "deviceOrientation": "PORTRAIT",
        "appiumVersion": "appium2-20250901",
    }
    
    # If a Sauce Connect tunnel name is provided, attach it so the device can reach localhost services
    sc_tunnel = os.getenv("SAUCE_TUNNEL_NAME") or os.getenv("SAUCE_SC_TUNNEL")
    if sc_tunnel:
        # Different fields used in various Sauce tooling; set both common keys
        sauce_options["tunnelIdentifier"] = sc_tunnel
        sauce_options["scTunnelName"] = sc_tunnel

    options.set_capability("sauce:options", sauce_options)
    
    return options

def get_local_options(app_path: str = None) -> UiAutomator2Options:
    """Configure options for local Appium testing."""
    options = UiAutomator2Options()
    
    options.platform_name = "Android"
    options.automation_name = "UiAutomator2"
    
    if app_path:
        options.app = app_path
    else:
        # Use installed app
        options.app_package = APP_PACKAGE
        options.app_activity = APP_ACTIVITY
        options.no_reset = True
    
    # For emulator
    options.device_name = os.getenv("ANDROID_DEVICE_NAME", "Android Emulator")
    
    return options


@pytest.fixture(
    params=_sauce_device_matrix(),
    ids=lambda d: f"{d['name'].replace(' ', '_')}-{d['platform_version']}",
    scope="function",
)
def android_driver_sauce(request):
    """
    Fixture for running tests on Sauce Labs Real Device Cloud.
    Parametrized to run on multiple devices (or a single device if
    SAUCE_DEVICE_NAME is set).
    """
    if not SAUCE_USERNAME or not SAUCE_ACCESS_KEY:
        pytest.skip("SAUCE_USERNAME and SAUCE_ACCESS_KEY must be set for Sauce Labs tests")

    device_config = request.param
    test_name = request.node.name

    options = get_sauce_options(test_name, device_config["name"])
    options.platform_version = device_config["platform_version"]
    
    driver = webdriver.Remote(
        command_executor=SAUCE_URL,
        options=options
    )
    
    session_id = driver.session_id
    yield driver
    
    # Report pass/fail AND the failure reason back to Sauce.
    # Sauce's RDC job API has no error field, so the reason travels in the
    # job name and a failure:<reason> tag - see sauce_result_reporter.py.
    _sid, _body, _ok = report_result(driver, request)
    
    driver.quit()
    report_result_after_quit(_sid, _body, _ok)


@pytest.fixture(scope="function")
def android_driver_local(request):
    """
    Fixture for running tests on local emulator/device.
    Requires Appium server running locally.
    """
    app_path = os.getenv("ANDROID_APP_PATH")
    options = get_local_options(app_path)
    
    driver = webdriver.Remote(
        command_executor=LOCAL_APPIUM_URL,
        options=options
    )
    
    yield driver
    driver.quit()


@pytest.fixture(scope="function")
def android_driver(request):
    """
    Smart fixture that uses Sauce Labs if credentials are available,
    otherwise falls back to local Appium.
    Uses environment variables SAUCE_DEVICE_NAME and SAUCE_PLATFORM_VERSION if set.
    """
    test_name = request.node.name
    
    if SAUCE_USERNAME and SAUCE_ACCESS_KEY:
        # Use Sauce Labs — honor SAUCE_DEVICE_NAME / SAUCE_PLATFORM_VERSION
        # so a single command can target whatever device you picked from the
        # Sauce RDC VS Code extension.
        device_name = os.getenv("SAUCE_DEVICE_NAME", DEFAULT_SAUCE_DEVICE_NAME)
        platform_version = os.getenv("SAUCE_PLATFORM_VERSION", DEFAULT_SAUCE_PLATFORM_VERSION)
        options = get_sauce_options(test_name, device_name)
        options.platform_version = platform_version
        
        driver = webdriver.Remote(
            command_executor=SAUCE_URL,
            options=options
        )
        
        yield driver
        
        # Report pass/fail AND the failure reason back to Sauce.
        # Sauce's RDC job API has no error field, so the reason travels in the
        # job name and a failure:<reason> tag - see sauce_result_reporter.py.
        _sid, _body, _ok = report_result(driver, request)
        driver.quit()
        report_result_after_quit(_sid, _body, _ok)
    else:
        # Use local Appium
        app_path = os.getenv("ANDROID_APP_PATH")
        options = get_local_options(app_path)
        
        driver = webdriver.Remote(
            command_executor=LOCAL_APPIUM_URL,
            options=options
        )
        
        yield driver
        driver.quit()


# Hook to capture test results for Sauce Labs reporting
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)